"""NVAPI-based detection for NVIDIA Mosaic topology and GSync devices.

This module loads ``nvapi64.dll`` via ctypes and resolves NVAPI functions by
hash ID. It is intentionally defensive: on any non-NVIDIA system (DLL missing),
on NVAPI init failure, or on any per-call failure, public functions return
``None`` rather than raising.

Public API:
    NVAPI_AVAILABLE: bool — True only after a successful NvAPI_Initialize call.
    detect_mosaic() -> dict | None — current Mosaic topology, if any.
    get_physical_display_ids() -> list[int] | None — physical display IDs behind Mosaic.
    detect_sync() -> dict | None — GSync device status summary.
"""

import ctypes
import logging
import os
import threading
from ctypes import (
    POINTER,
    Structure,
    byref,
    c_char,
    c_float,
    c_int,
    c_uint,
    c_uint32,
    c_void_p,
    sizeof,
)

logger = logging.getLogger(__name__)

# NVAPI constants
NVAPI_OK = 0
NVAPI_MAX_PHYSICAL_GPUS = 64
NVAPI_MAX_DISPLAYS = 64
NV_MOSAIC_MAX_DISPLAYS = 64
NVAPI_MAX_MOSAIC_DISPLAY_ROWS = 8
NVAPI_MAX_MOSAIC_DISPLAY_COLUMNS = 8
NVAPI_MAX_MOSAIC_TOPOS = 16
NVAPI_GENERIC_STRING_MAX = 4096
NVAPI_SHORT_STRING_MAX = 64
NV_MOSAIC_DISPLAY_SETTINGS_MAX = 40
NVAPI_MAX_GSYNC_DEVICES = 4

# Function ID hashes (from community nvapi.h — corrected per task instructions)
_FUNC_NvAPI_Initialize = 0x0150E828
_FUNC_NvAPI_Mosaic_GetCurrentTopo = 0xCB01E1D5
_FUNC_NvAPI_Mosaic_EnumDisplayGrids = 0xDF2887AF
_FUNC_NvAPI_GPU_GetConnectedDisplayIds = 0x0078DBA2
_FUNC_NvAPI_GSync_EnumSyncDevices = 0xD9639601
_FUNC_NvAPI_GSync_GetStatusParameters = 0xCDAACBC7

# Opaque handles
NvDisplayHandle = c_void_p
NvPhysicalGpuHandle = c_void_p
NvLogicalGpuHandle = c_void_p
NvGSyncDeviceHandle = c_void_p

# Module state
NVAPI_AVAILABLE = False
_nvapi_dll = None
_query_interface = None
_initialized = False
_func_cache: dict = {}

# Protects one-time init and _func_cache mutations across threads.
# The main service loop and the metrics loop both call into this module
# concurrently, so check-then-set on _initialized and cache writes must
# be serialised. Reads use double-checked locking to keep the hot path lock-free.
# Reentrant because _initialize() (holding the lock) calls _bind() →
# _nvapi_query_interface(), which re-acquires the same lock.
_init_lock = threading.RLock()


def _make_version(struct_size: int, version: int) -> int:
    """NVAPI version encoding: (sizeof(struct) << 16) | API_VERSION."""
    return (struct_size << 16) | version


# ---------------------------------------------------------------------------
# ctypes structures
# ---------------------------------------------------------------------------

class NV_MOSAIC_TOPO_BRIEF(Structure):
    _fields_ = [
        ('version', c_uint32),
        ('topo', c_uint32),           # NV_MOSAIC_TOPO enum
        ('enabled', c_uint32),
        ('isPossible', c_uint32),
    ]


class NV_MOSAIC_DISPLAY_SETTING(Structure):
    """V2 structure — width/height/bpp/freq plus rrx1k (refresh * 1000)."""
    _fields_ = [
        ('version', c_uint32),
        ('width', c_uint32),
        ('height', c_uint32),
        ('bpp', c_uint32),
        ('freq', c_uint32),
        ('rrx1k', c_uint32),
    ]


class NV_MOSAIC_GRID_TOPO_DISPLAY(Structure):
    """Single display entry inside a Mosaic grid.

    Layout per community nvapi.h (V2):
        NvU32 version
        NvU32 displayId
        NvS32 overlapX
        NvS32 overlapY
        NV_ROTATE rotation
        NvU32 cloneGroup
        NV_PIXEL_SHIFT_TYPE pixelShiftType
    """
    _fields_ = [
        ('version', c_uint32),
        ('displayId', c_uint32),
        ('overlapX', c_int),
        ('overlapY', c_int),
        ('rotation', c_uint32),
        ('cloneGroup', c_uint32),
        ('pixelShiftType', c_uint32),
    ]


class NV_MOSAIC_GRID_TOPO(Structure):
    """Grid topology — rows x cols of displays forming one logical surface.

    Layout per community nvapi.h (V2):
        NvU32 version
        NvU32 rows
        NvU32 columns
        NvU32 displayCount
        NvU32 flags (bitfield: applyWithBezelCorrect, immersiveGaming, baseMosaic,
                     driverReloadAllowed, acceleratePrimaryDisplay)
        NV_MOSAIC_GRID_TOPO_DISPLAY displays[NV_MOSAIC_MAX_DISPLAYS]
        NV_MOSAIC_DISPLAY_SETTING displaySettings
    """
    _fields_ = [
        ('version', c_uint32),
        ('rows', c_uint32),
        ('columns', c_uint32),
        ('displayCount', c_uint32),
        ('flags', c_uint32),
        ('displays', NV_MOSAIC_GRID_TOPO_DISPLAY * NV_MOSAIC_MAX_DISPLAYS),
        ('displaySettings', NV_MOSAIC_DISPLAY_SETTING),
    ]


class NV_GPU_DISPLAYIDS(Structure):
    """Connected display descriptor for NvAPI_GPU_GetConnectedDisplayIds."""
    _fields_ = [
        ('version', c_uint32),
        ('connectorType', c_uint32),
        ('displayId', c_uint32),
        ('flags', c_uint32),
    ]


class NV_GSYNC_STATUS_PARAMS(Structure):
    """Subset of GSync status we care about — matches V1 layout.

    Community nvapi.h:
        NvU32 version
        NvU32 refreshRate
        NvU32 RJ45_IO[2]
        NvU32 RJ45_Ethernet[2]
        NvU32 houseSyncIncoming
        NvU32 bHouseSync
    """
    _fields_ = [
        ('version', c_uint32),
        ('refreshRate', c_uint32),
        ('RJ45_IO', c_uint32 * 2),
        ('RJ45_Ethernet', c_uint32 * 2),
        ('houseSyncIncoming', c_uint32),
        ('bHouseSync', c_uint32),
    ]


# Version constants
NV_MOSAIC_TOPO_BRIEF_VER = _make_version(sizeof(NV_MOSAIC_TOPO_BRIEF), 1)
NV_MOSAIC_DISPLAY_SETTING_VER_2 = _make_version(sizeof(NV_MOSAIC_DISPLAY_SETTING), 2)
NV_MOSAIC_GRID_TOPO_DISPLAY_VER = _make_version(sizeof(NV_MOSAIC_GRID_TOPO_DISPLAY), 2)
NV_MOSAIC_GRID_TOPO_VER = _make_version(sizeof(NV_MOSAIC_GRID_TOPO), 2)
NV_GPU_DISPLAYIDS_VER = _make_version(sizeof(NV_GPU_DISPLAYIDS), 3)
NV_GSYNC_STATUS_PARAMS_VER = _make_version(sizeof(NV_GSYNC_STATUS_PARAMS), 1)


# ---------------------------------------------------------------------------
# DLL + QueryInterface bootstrap
# ---------------------------------------------------------------------------

def _load_dll():
    """Load nvapi64.dll if present. Returns the handle or None."""
    dll_path = os.path.join(os.environ.get('WINDIR', r'C:\Windows'), 'System32', 'nvapi64.dll')
    if not os.path.isfile(dll_path):
        logger.debug('nvapi64.dll not found at %s — NVAPI disabled', dll_path)
        return None
    try:
        dll = ctypes.WinDLL(dll_path)
    except Exception as e:
        logger.info('Failed to load nvapi64.dll: %s', e)
        return None

    try:
        qi = dll.nvapi_QueryInterface
    except AttributeError:
        logger.info('nvapi64.dll is missing nvapi_QueryInterface export')
        return None
    qi.restype = c_void_p
    qi.argtypes = [c_uint32]
    return dll


def _nvapi_query_interface(function_id: int):
    """Resolve an NVAPI function pointer by its hash ID. Returns a c_void_p or None.

    Thread-safe: fast-path cache read is lock-free; resolution + cache write are
    serialised under ``_init_lock`` with a re-check after acquisition to avoid
    redundant QueryInterface calls when multiple threads race on the same ID.
    """
    if _query_interface is None:
        return None
    # Fast path — dict.get is atomic under the GIL for a single key lookup.
    if function_id in _func_cache:
        return _func_cache[function_id]
    with _init_lock:
        # Re-check: another thread may have resolved this while we waited.
        if function_id in _func_cache:
            return _func_cache[function_id]
        try:
            addr = _query_interface(c_uint32(function_id))
        except Exception as e:
            logger.warning('nvapi_QueryInterface(0x%08X) raised: %s', function_id, e)
            return None
        if not addr:
            logger.debug('nvapi_QueryInterface(0x%08X) returned NULL', function_id)
            _func_cache[function_id] = None
            return None
        _func_cache[function_id] = addr
        return addr


def _bind(function_id: int, restype, argtypes):
    """Return a callable for the given NVAPI function, or None."""
    addr = _nvapi_query_interface(function_id)
    if not addr:
        return None
    proto = ctypes.WINFUNCTYPE(restype, *argtypes)
    try:
        return proto(addr)
    except Exception as e:
        logger.warning('Failed to bind NVAPI function 0x%08X: %s', function_id, e)
        return None


def _initialize() -> bool:
    """Load DLL and call NvAPI_Initialize. Idempotent; safe on non-NVIDIA systems.

    Thread-safe via double-checked locking on ``_init_lock``. The fast path
    (already-initialised) returns without acquiring the lock; the slow path
    re-checks ``_initialized`` after acquisition to avoid duplicate init.
    """
    global NVAPI_AVAILABLE, _nvapi_dll, _query_interface, _initialized

    if _initialized:
        return NVAPI_AVAILABLE

    with _init_lock:
        # Re-check: another thread may have completed init while we waited.
        if _initialized:
            return NVAPI_AVAILABLE

        _initialized = True
        _nvapi_dll = _load_dll()
        if _nvapi_dll is None:
            return False

        _query_interface = _nvapi_dll.nvapi_QueryInterface

        init_fn = _bind(_FUNC_NvAPI_Initialize, c_int, [])
        if init_fn is None:
            logger.info('NvAPI_Initialize could not be resolved — NVAPI disabled')
            return False
        try:
            status = init_fn()
        except Exception as e:
            logger.warning('NvAPI_Initialize raised: %s', e)
            return False
        if status != NVAPI_OK:
            logger.info('NvAPI_Initialize returned status %d — NVAPI disabled', status)
            return False

        NVAPI_AVAILABLE = True
        logger.debug('NVAPI initialized successfully')
        return True


# Initialize at import so module-level NVAPI_AVAILABLE is meaningful immediately.
_initialize()


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def detect_mosaic():
    """Return current NVIDIA Mosaic topology, or None if unavailable/inactive.

    Shape::

        {
          'active': bool,
          'grids': [
            {
              'rows': int,
              'cols': int,
              'compositeWidth': int,
              'compositeHeight': int,
              'members': [{'displayId': int, 'row': int, 'col': int}]
            }
          ]
        }
    """
    if not NVAPI_AVAILABLE:
        return None

    try:
        # First, read the brief topology to know whether Mosaic is enabled.
        get_current_topo = _bind(
            _FUNC_NvAPI_Mosaic_GetCurrentTopo,
            c_int,
            [POINTER(NV_MOSAIC_TOPO_BRIEF), POINTER(NV_MOSAIC_DISPLAY_SETTING), POINTER(c_int)],
        )
        enum_display_grids = _bind(
            _FUNC_NvAPI_Mosaic_EnumDisplayGrids,
            c_int,
            [POINTER(NV_MOSAIC_GRID_TOPO), POINTER(c_uint32)],
        )
        if enum_display_grids is None:
            logger.debug('NvAPI_Mosaic_EnumDisplayGrids unavailable')
            return None

        active = False
        if get_current_topo is not None:
            brief = NV_MOSAIC_TOPO_BRIEF()
            brief.version = NV_MOSAIC_TOPO_BRIEF_VER
            setting = NV_MOSAIC_DISPLAY_SETTING()
            setting.version = NV_MOSAIC_DISPLAY_SETTING_VER_2
            overlap = c_int(0)
            try:
                status = get_current_topo(byref(brief), byref(setting), byref(overlap))
                if status == NVAPI_OK:
                    active = bool(brief.enabled)
                else:
                    logger.debug('NvAPI_Mosaic_GetCurrentTopo status=%d', status)
            except Exception as e:
                logger.warning('NvAPI_Mosaic_GetCurrentTopo raised: %s', e)

        # Query grid count first, then fetch that many.
        count = c_uint32(0)
        try:
            status = enum_display_grids(None, byref(count))
        except Exception as e:
            logger.warning('NvAPI_Mosaic_EnumDisplayGrids (count) raised: %s', e)
            return None
        if status != NVAPI_OK:
            logger.debug('NvAPI_Mosaic_EnumDisplayGrids (count) status=%d', status)
            return None
        if count.value == 0:
            return {'active': active, 'grids': []} if active else None

        GridArray = NV_MOSAIC_GRID_TOPO * count.value
        grids_buf = GridArray()
        for i in range(count.value):
            grids_buf[i].version = NV_MOSAIC_GRID_TOPO_VER
            for j in range(NV_MOSAIC_MAX_DISPLAYS):
                grids_buf[i].displays[j].version = NV_MOSAIC_GRID_TOPO_DISPLAY_VER
            grids_buf[i].displaySettings.version = NV_MOSAIC_DISPLAY_SETTING_VER_2
        try:
            status = enum_display_grids(grids_buf, byref(count))
        except Exception as e:
            logger.warning('NvAPI_Mosaic_EnumDisplayGrids (fill) raised: %s', e)
            return None
        if status != NVAPI_OK:
            logger.debug('NvAPI_Mosaic_EnumDisplayGrids (fill) status=%d', status)
            return None

        grids_out = []
        for i in range(count.value):
            g = grids_buf[i]
            rows = int(g.rows)
            cols = int(g.columns)
            display_count = min(int(g.displayCount), NV_MOSAIC_MAX_DISPLAYS)
            cell_w = int(g.displaySettings.width)
            cell_h = int(g.displaySettings.height)
            composite_w = cell_w * cols if cell_w and cols else 0
            composite_h = cell_h * rows if cell_h and rows else 0

            members = []
            # NVAPI lays out displays in row-major order.
            for idx in range(display_count):
                d = g.displays[idx]
                if cols > 0:
                    row = idx // cols
                    col = idx % cols
                else:
                    row = 0
                    col = idx
                members.append({
                    'displayId': int(d.displayId),
                    'row': row,
                    'col': col,
                })

            grids_out.append({
                'rows': rows,
                'cols': cols,
                'compositeWidth': composite_w,
                'compositeHeight': composite_h,
                'members': members,
            })

        if not active and not grids_out:
            return None
        return {'active': active, 'grids': grids_out}
    except Exception as e:
        logger.warning('detect_mosaic() failed: %s', e)
        return None


def get_physical_display_ids():
    """Return a list of physical display IDs exposed by NVAPI grids.

    When Mosaic is active, Windows / EDID APIs often see only the composite
    logical display. NVAPI still reports the underlying physical display IDs
    via the grid topology — use those IDs for EDID lookup.

    Returns None if NVAPI is unavailable; returns [] if no grids are present.
    """
    if not NVAPI_AVAILABLE:
        return None
    try:
        mosaic = detect_mosaic()
        if not mosaic:
            return []
        ids = []
        seen = set()
        for grid in mosaic.get('grids', []) or []:
            for member in grid.get('members', []) or []:
                did = member.get('displayId')
                if did is None or did in seen:
                    continue
                seen.add(did)
                ids.append(int(did))
        return ids
    except Exception as e:
        logger.warning('get_physical_display_ids() failed: %s', e)
        return None


def detect_sync():
    """Return GSync device status, or None if unavailable.

    Shape::

        {'devices': [{'id': int, 'master': bool, 'locked': bool}]}
    """
    if not NVAPI_AVAILABLE:
        return None

    try:
        enum_sync = _bind(
            _FUNC_NvAPI_GSync_EnumSyncDevices,
            c_int,
            [NvGSyncDeviceHandle * NVAPI_MAX_GSYNC_DEVICES, POINTER(c_uint32)],
        )
        if enum_sync is None:
            logger.debug('NvAPI_GSync_EnumSyncDevices unavailable')
            return None

        handles = (NvGSyncDeviceHandle * NVAPI_MAX_GSYNC_DEVICES)()
        count = c_uint32(0)
        try:
            status = enum_sync(handles, byref(count))
        except Exception as e:
            logger.warning('NvAPI_GSync_EnumSyncDevices raised: %s', e)
            return None
        if status != NVAPI_OK:
            logger.debug('NvAPI_GSync_EnumSyncDevices status=%d', status)
            return None
        if count.value == 0:
            return None

        get_status = _bind(
            _FUNC_NvAPI_GSync_GetStatusParameters,
            c_int,
            [NvGSyncDeviceHandle, POINTER(NV_GSYNC_STATUS_PARAMS)],
        )

        devices = []
        for i in range(count.value):
            handle = handles[i]
            # Device identity: use the handle address as a stable-within-process ID.
            # The real NVAPI device ID would require NvAPI_GSync_GetTopology, which
            # is out of scope here — the handle pointer is sufficient for reporting.
            dev_id = int(ctypes.cast(handle, c_void_p).value or 0)

            master = False
            locked = False
            if get_status is not None:
                params = NV_GSYNC_STATUS_PARAMS()
                params.version = NV_GSYNC_STATUS_PARAMS_VER
                try:
                    st = get_status(handle, byref(params))
                    if st == NVAPI_OK:
                        # House sync / refresh presence implies the sync board is locked.
                        locked = bool(params.refreshRate) or bool(params.bHouseSync)
                        master = bool(params.bHouseSync)
                    else:
                        logger.debug('NvAPI_GSync_GetStatusParameters[%d] status=%d', i, st)
                except Exception as e:
                    logger.warning('NvAPI_GSync_GetStatusParameters[%d] raised: %s', i, e)

            devices.append({
                'id': dev_id,
                'master': master,
                'locked': locked,
            })

        return {'devices': devices} if devices else None
    except Exception as e:
        logger.warning('detect_sync() failed: %s', e)
        return None


if __name__ == '__main__':
    logging.basicConfig(level=logging.DEBUG, format='%(levelname)s %(name)s: %(message)s')
    print('NVAPI_AVAILABLE:', NVAPI_AVAILABLE)
    print('detect_mosaic():', detect_mosaic())
    print('get_physical_display_ids():', get_physical_display_ids())
    print('detect_sync():', detect_sync())
