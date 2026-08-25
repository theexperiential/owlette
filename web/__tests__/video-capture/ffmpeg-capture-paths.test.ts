/** @jest-environment node */
/**
 * Capture-path planning for the tutorial video recorder. Guards the wiring gap
 * where buildFallbackFfmpegArgs existed but nothing ever selected it.
 */
import {
  planCapturePaths,
  resolveCapturePathMode,
  diagnoseCaptureFailure,
} from '@/e2e/videos/ffmpeg-recorder';

const REGION = { offsetX: 0, offsetY: 122, width: 1920, height: 958 };

describe('resolveCapturePathMode', () => {
  it('defaults to auto', () => {
    expect(resolveCapturePathMode({})).toBe('auto');
    expect(resolveCapturePathMode({ OWLETTE_VIDEO_CAPTURE_PATH: '' })).toBe('auto');
  });

  it('honors an explicit pin, case-insensitively', () => {
    expect(resolveCapturePathMode({ OWLETTE_VIDEO_CAPTURE_PATH: 'Fallback' })).toBe('fallback');
    expect(resolveCapturePathMode({ OWLETTE_VIDEO_CAPTURE_PATH: 'primary' })).toBe('primary');
  });

  it('warns and falls back to auto on an unknown value', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveCapturePathMode({ OWLETTE_VIDEO_CAPTURE_PATH: 'nvenc' })).toBe('auto');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('planCapturePaths', () => {
  it('tries the NVENC path first and the GDI path second', () => {
    const paths = planCapturePaths(REGION, 'auto');
    expect(paths).toHaveLength(2);
    expect(paths[0].args.join(' ')).toContain('ddagrab');
    expect(paths[0].args).toContain('h264_nvenc');
    expect(paths[1].args).toContain('gdigrab');
    expect(paths[1].args).toContain('libx264');
  });

  it('carries the measured region into BOTH paths', () => {
    const [primary, fallback] = planCapturePaths(REGION, 'auto');
    expect(primary.args.join(' ')).toContain('offset_y=122');
    expect(primary.args.join(' ')).toContain('video_size=1920x958');
    expect(fallback.args).toEqual(
      expect.arrayContaining(['-offset_y', '122', '-video_size', '1920x958']),
    );
  });

  it('pins a single path when asked', () => {
    expect(planCapturePaths(REGION, 'primary')).toHaveLength(1);
    expect(planCapturePaths(REGION, 'fallback')[0].args).toContain('gdigrab');
  });
});

describe('diagnoseCaptureFailure', () => {
  it('names the real ffmpeg failures seen on a non-NVENC box', () => {
    expect(diagnoseCaptureFailure("Unknown encoder 'h264_nvenc'")).toMatch(/h264_nvenc/);
    expect(diagnoseCaptureFailure("No such filter: 'ddagrab'")).toMatch(/ddagrab/);
    expect(diagnoseCaptureFailure('Failed to enumerate DXGI output 7')).toMatch(/duplication/i);
  });

  it('returns null for an unrecognized failure', () => {
    expect(diagnoseCaptureFailure('Conversion failed!')).toBeNull();
  });
});
