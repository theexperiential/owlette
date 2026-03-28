'use client';

import React, { useEffect, useState, useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useMachines, useSites, type LaunchMode, type ScheduleBlock } from '@/hooks/useFirestore';
import { DEFAULT_SCHEDULE } from '@/lib/scheduleDefaults';
import { useSchedulePresets } from '@/hooks/useSchedulePresets';
import { useDeployments } from '@/hooks/useDeployments';
import { useMachineOperations } from '@/hooks/useMachineOperations';
import { useInstallerVersion } from '@/hooks/useInstallerVersion';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import { Plus, LayoutGrid, List, ChevronDown, ChevronUp, ChevronsUpDown, ChevronsDownUp, Square, Copy, Pencil, Trash2, Download, Monitor, Wifi, Cog, Settings2 } from 'lucide-react';
import { AccountSettingsDialog } from '@/components/AccountSettingsDialog';
import { Table, TableBody } from '@/components/ui/table';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Switch } from '@/components/ui/switch';
import { ManageSitesDialog } from '@/components/ManageSitesDialog';
import { CreateSiteDialog } from '@/components/CreateSiteDialog';
import DownloadButton from '@/components/DownloadButton';
import { MachineContextMenu } from '@/components/MachineContextMenu';
import { RemoveMachineDialog } from '@/components/RemoveMachineDialog';
import { ScreenshotDialog } from '@/components/ScreenshotDialog';
import { LiveViewModal } from '@/components/LiveViewModal';
import { PageHeader } from '@/components/PageHeader';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { formatTemperature, getTemperatureColorClass } from '@/lib/temperatureUtils';
import { formatStorageRange } from '@/lib/storageUtils';
import { MetricsDetailPanel, type MetricType } from '@/components/charts';
import ScheduleEditor from '@/components/ScheduleEditor';
import { MachineCardView } from './components/MachineCardView';
import { MachineRow, MemoizedTableHeader as ListViewTableHeader } from './components/MachineListView';
import { AddMachineButton } from './components/AddMachineButton';
import type { Process } from '@/hooks/useFirestore';

type ViewType = 'card' | 'list';

// State for metrics detail panel
interface DetailPanelState {
  machineId: string;
  machineName: string;
  metric: MetricType;
}

export default function DashboardPage() {
  const router = useRouter();
  const { user, loading, signOut, isAdmin, userSites, lastSiteId, updateLastSite, requiresMfaSetup, userPreferences, updateUserPreferences } = useAuth();
  const { sites, loading: sitesLoading, createSite, updateSite, deleteSite } = useSites(user?.uid, userSites, isAdmin);
  const { version, downloadUrl } = useInstallerVersion();
  const [currentSiteId, setCurrentSiteId] = useState<string>('');
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [manageDialogOpen, setManageDialogOpen] = useState(false);
  const [viewType, setViewType] = useState<ViewType>('card');
  const [accountSettingsOpen, setAccountSettingsOpen] = useState(false);

  // Delay showing "Getting Started" to avoid flash if machines are still loading
  const [canShowGettingStarted, setCanShowGettingStarted] = useState(false);

  // Schedule Editor dialog state (single instance, opened by gear icon on any process)
  const [scheduleEditorOpen, setScheduleEditorOpen] = useState(false);
  const [scheduleEditorTarget, setScheduleEditorTarget] = useState<{ machineId: string; process: Process } | null>(null);

  const handleConfigureSchedule = (machineId: string, process: Process) => {
    setScheduleEditorTarget({ machineId, process });
    setScheduleEditorOpen(true);
  };

  const handleScheduleApply = (schedules: ScheduleBlock[], presetId: string | null) => {
    if (scheduleEditorTarget) {
      const { machineId, process } = scheduleEditorTarget;
      handleSetLaunchMode(machineId, process.id, process.name, 'scheduled', process.exe_path, schedules, presetId);
    }
    setScheduleEditorOpen(false);
    setScheduleEditorTarget(null);
  };

  const handleCreatePreset = async (name: string, blocks: ScheduleBlock[]) => {
    if (!user?.uid) return;
    await createPreset({
      name,
      blocks,
      isBuiltIn: false,
      order: 99,
      createdBy: user.uid,
    });
    toast.success(`Preset "${name}" saved`);
  };

  // Process Dialog state (supports both create and edit modes)
  const [processDialogOpen, setProcessDialogOpen] = useState(false);
  const [processDialogMode, setProcessDialogMode] = useState<'create' | 'edit'>('edit');
  const [editingMachineId, setEditingMachineId] = useState<string>('');
  const [editingProcessId, setEditingProcessId] = useState<string>('');
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [editProcessForm, setEditProcessForm] = useState<{
    name: string; exe_path: string; file_path: string; cwd: string;
    priority: string; visibility: string; time_delay: string; time_to_init: string;
    relaunch_attempts: string; autolaunch: boolean; launch_mode: LaunchMode; schedules: ScheduleBlock[] | null;
  }>({
    name: '',
    exe_path: '',
    file_path: '',
    cwd: '',
    priority: 'Normal',
    visibility: 'Normal',
    time_delay: '0',
    time_to_init: '10',
    relaunch_attempts: '3',
    autolaunch: false,
    launch_mode: 'off',
    schedules: null,
  });

  const { machines, loading: machinesLoading, killProcess, setLaunchMode, updateProcess, deleteProcess, createProcess, rebootMachine, shutdownMachine, cancelReboot, dismissRebootPending, captureScreenshot, startLiveView, stopLiveView } = useMachines(currentSiteId);
  const { presets: schedulePresets, createPreset, deletePreset: deleteSchedulePreset, updatePreset: updateSchedulePreset } = useSchedulePresets(currentSiteId);
  const { checkMachineHasActiveDeployment } = useDeployments(currentSiteId);
  const { removeMachineFromSite, removing: isRemovingMachine } = useMachineOperations(currentSiteId);

  // Per-row expand state for list view
  const [expandedMachineIds, setExpandedMachineIds] = useState<Set<string>>(() => new Set());

  // Sync expanded set when machines change (expand new machines if global pref is expanded)
  useEffect(() => {
    if (userPreferences.processesExpanded) {
      setExpandedMachineIds(new Set(machines.map(m => m.machineId)));
    }
  }, [machines.length, userPreferences.processesExpanded]);

  // Remove Machine Dialog state
  const [removeMachineDialogOpen, setRemoveMachineDialogOpen] = useState(false);
  const [machineToRemove, setMachineToRemove] = useState<{ id: string; name: string; isOnline: boolean } | null>(null);

  // Kill Process Confirmation state
  const [killConfirmOpen, setKillConfirmOpen] = useState(false);
  const [killTarget, setKillTarget] = useState<{ machineId: string; processId: string; processName: string } | null>(null);

  // Screenshot Dialog state
  const [screenshotDialogOpen, setScreenshotDialogOpen] = useState(false);
  const [screenshotTarget, setScreenshotTarget] = useState<{ machineId: string; machineName: string; isOnline: boolean } | null>(null);

  // Live View Modal state
  const [liveViewOpen, setLiveViewOpen] = useState(false);
  const [liveViewTarget, setLiveViewTarget] = useState<{ machineId: string; machineName: string } | null>(null);

  // Metrics Detail Panel state (replaces top stats cards when active)
  const [detailPanel, setDetailPanel] = useState<DetailPanelState | null>(null);

  // Multilingual welcome messages with language info (memoized to avoid recreation)
  const welcomeMessages = useMemo(() => [
    // English (heavy)
    { text: "Welcome back", language: "English", translation: "Welcome back" },
    { text: "Greetings", language: "English", translation: "Greetings" },
    { text: "Hey there", language: "English (casual)", translation: "Hey there" },
    { text: "Good to see you", language: "English", translation: "Good to see you" },
    { text: "Hello again", language: "English", translation: "Hello again" },
    { text: "Welcome", language: "English", translation: "Welcome" },
    { text: "Howdy", language: "English (Southern US)", translation: "Howdy" },
    { text: "What's up", language: "English (casual)", translation: "What's up" },
    { text: "G'day", language: "English (Australian)", translation: "G'day / Good day" },
    { text: "Cheers", language: "English (British)", translation: "Cheers / Hello" },

    // Spanish (heavy)
    { text: "Bienvenido", language: "Spanish", translation: "Welcome" },
    { text: "Hola de nuevo", language: "Spanish", translation: "Hello again" },
    { text: "Qué tal", language: "Spanish (casual)", translation: "What's up / How's it going" },
    { text: "Saludos", language: "Spanish", translation: "Greetings" },
    { text: "Buenas", language: "Spanish (casual)", translation: "Hey / Hi there" },
    { text: "Hola", language: "Spanish", translation: "Hello" },
    { text: "Bienvenido de vuelta", language: "Spanish", translation: "Welcome back" },
    { text: "Qué onda", language: "Spanish (Mexican)", translation: "What's up" },
    { text: "¿Cómo estás?", language: "Spanish", translation: "How are you?" },
    { text: "Encantado de verte", language: "Spanish", translation: "Pleased to see you" },

    // French
    { text: "Bienvenue", language: "French", translation: "Welcome" },
    { text: "Salut", language: "French (casual)", translation: "Hi" },
    { text: "Bon retour", language: "French", translation: "Good return / Welcome back" },

    // German
    { text: "Willkommen zurück", language: "German", translation: "Welcome back" },
    { text: "Hallo", language: "German", translation: "Hello" },
    { text: "Grüß dich", language: "German (casual)", translation: "Greetings to you" },

    // Italian
    { text: "Benvenuto", language: "Italian", translation: "Welcome" },
    { text: "Ciao", language: "Italian", translation: "Hi / Bye" },

    // Portuguese
    { text: "Bem-vindo de volta", language: "Portuguese", translation: "Welcome back" },
    { text: "Olá", language: "Portuguese", translation: "Hello" },

    // Dutch
    { text: "Welkom terug", language: "Dutch", translation: "Welcome back" },

    // Russian
    { text: "Добро пожаловать", language: "Russian", translation: "Welcome" },
    { text: "Привет", language: "Russian", translation: "Hi" },

    // Asian languages
    { text: "欢迎回来", language: "Chinese (Simplified)", translation: "Welcome back" },
    { text: "ようこそ", language: "Japanese", translation: "Welcome" },
    { text: "환영합니다", language: "Korean", translation: "Welcome" },
    { text: "स्वागत है", language: "Hindi", translation: "Welcome" },
    { text: "ยินดีต้อนรับกลับมา", language: "Thai", translation: "Welcome back" },
    { text: "Chào mừng trở lại", language: "Vietnamese", translation: "Welcome back" },

    // Middle Eastern
    { text: "مرحبا بعودتك", language: "Arabic", translation: "Welcome back" },
    { text: "ברוך השב", language: "Hebrew", translation: "Blessed is the return" },
    { text: "Hoş geldin", language: "Turkish", translation: "Welcome" },

    // Scandinavian
    { text: "Välkommen tillbaka", language: "Swedish", translation: "Welcome back" },
    { text: "Velkommen tilbage", language: "Danish", translation: "Welcome back" },
    { text: "Velkommen tilbake", language: "Norwegian", translation: "Welcome back" },
    { text: "Tervetuloa takaisin", language: "Finnish", translation: "Welcome back" },

    // Other European
    { text: "Witaj ponownie", language: "Polish", translation: "Welcome again" },
    { text: "Vítejte zpět", language: "Czech", translation: "Welcome back" },
    { text: "Καλώς ήρθες πάλι", language: "Greek", translation: "Welcome back" },
    { text: "Bine ai revenit", language: "Romanian", translation: "Good you returned" },

    // Southeast Asian
    { text: "Selamat datang kembali", language: "Indonesian", translation: "Safe arrival back" },
    { text: "Maligayang pagbabalik", language: "Filipino", translation: "Happy return" },

    // Celtic
    { text: "Fàilte air ais", language: "Scottish Gaelic", translation: "Welcome back" },
    { text: "Croeso yn ôl", language: "Welsh", translation: "Welcome back" },
    { text: "Fáilte ar ais", language: "Irish", translation: "Welcome back" },
  ], []);

  // Random cheesy tech jokes (memoized)
  const techJokes = useMemo(() => [
    "Your pixels are in good hands",
    "Keeping your GPUs well-fed and happy",
    "Because Ctrl+Alt+Delete is so 2000s",
    "Herding your processes since 2025",
    "Making sure your renders don't surrender",
    "Your CPU's personal trainer",
    "We put the 'auto' in autolaunch",
    "Babysitting processes so you don't have to",
    "Keeping the frames flowing",
    "Process management: Now streaming",
    "Your digital janitor service",
    "Making computers computier since 2025",
    "Because someone has to babysit your GPUs",
    "Turning crashes into... well, less crashes",
    "Your processes' favorite nanny",
    "We'll handle the restarts, you handle the art",
    "Keeping your render farm from going on strike",
    "Process wrangling at its finest",
    "Making sure your video doesn't get stagefright",
    "Your machines' remote control, literally",
    "Teaching old GPUs new tricks",
    "We don't judge your 47 Chrome tabs",
    "Remotely judging your cable management",
    "Making Windows behave since 2025",
    "Your processes called, they want a manager",
    "Turning blue screens into green lights",
    "The cloud's favorite floor manager",
    "Because 'Have you tried turning it off and on again?' gets old",
    "Your GPU's therapist",
    "Making sure your RAM doesn't feel lonely",
    "Process management with extra cheese",
    "We put the 'service' in Windows Service",
    "Keeping your video walls from having a meltdown",
    "Because manual restarts are for peasants",
    "Your installation's guardian angel",
    "Making TouchDesigner touch easier",
    "Render farm to table, fresh processes daily",
    "We speak fluent GPU",
    "Your digital signage's best friend",
    "Because someone needs to watch the watchers",
    "Turning 'It works on my machine' into reality",
    "Process therapy, cloud edition",
    "Making Resolume resolve to stay running",
    "Your kiosk's remote babysitter",
    "Because uptime is updog",
    "GPU whisperer extraordinaire",
    "Making your media servers less dramatic",
    "We've seen things... running things",
    "Your process's life coach",
    "Because closing Task Manager won't fix this",
    "Keeping your renders rendering since 2025",
    "The owl watches over your processes",
    "Making Windows services less mysterious",
    "Your exhibition's technical director",
    "Process management: It's not rocket science, it's harder"
  ], []);

  const [randomWelcome] = useState(() => welcomeMessages[Math.floor(Math.random() * welcomeMessages.length)]);
  const [randomJoke] = useState(() => techJokes[Math.floor(Math.random() * techJokes.length)]);

  const toggleStatsExpanded = useCallback(() => {
    updateUserPreferences({ statsExpanded: !userPreferences.statsExpanded }, { silent: true });
  }, [userPreferences.statsExpanded, updateUserPreferences]);

  const toggleProcessesExpanded = useCallback(() => {
    updateUserPreferences({ processesExpanded: !userPreferences.processesExpanded }, { silent: true });
  }, [userPreferences.processesExpanded, updateUserPreferences]);

  // Global expand/collapse all (both stats + processes)
  const allExpanded = expandedMachineIds.size === machines.length && machines.length > 0;

  const toggleAllExpanded = useCallback(() => {
    if (allExpanded) {
      setExpandedMachineIds(new Set());
      updateUserPreferences({ statsExpanded: false, processesExpanded: false }, { silent: true });
    } else {
      setExpandedMachineIds(new Set(machines.map(m => m.machineId)));
      updateUserPreferences({ statsExpanded: true, processesExpanded: true }, { silent: true });
    }
  }, [allExpanded, machines, updateUserPreferences]);

  // Per-machine expand toggle for list view
  const toggleMachineExpanded = useCallback((machineId: string) => {
    setExpandedMachineIds(prev => {
      const next = new Set(prev);
      if (next.has(machineId)) next.delete(machineId);
      else next.add(machineId);
      return next;
    });
  }, []);

  const handleRowClick = (_machineId: string, canExpand: boolean) => {
    // Don't toggle if user is selecting text
    const selection = window.getSelection();
    if (selection && selection.toString().length > 0) {
      return;
    }

    if (canExpand) {
      toggleProcessesExpanded();
    }
  };

  const handleKillProcess = (machineId: string, processId: string, processName: string) => {
    setKillTarget({ machineId, processId, processName });
    setKillConfirmOpen(true);
  };

  const confirmKillProcess = async () => {
    if (!killTarget) return;
    const { machineId, processId, processName } = killTarget;
    setKillConfirmOpen(false);
    setKillTarget(null);
    try {
      await killProcess(machineId, processId, processName);
      toast.success(`Kill command sent for "${processName}"`);
    } catch (error: any) {
      console.error('confirmKillProcess error:', error);
      toast.error(error.message || 'Failed to kill process');
    }
  };

  const handleSetLaunchMode = async (machineId: string, processId: string, processName: string, mode: 'off' | 'always' | 'scheduled', exePath: string, schedules?: any[] | null, schedulePresetId?: string | null) => {
    // Validate exe_path before enabling
    if (mode !== 'off' && (!exePath || exePath.trim() === '')) {
      toast.error(`cannot enable launch mode for "${processName}": executable path is not set. please edit the process and set a valid executable path.`);
      return;
    }

    try {
      // When activating scheduled mode without schedules, use default (M-F 9-5)
      const effectiveSchedules = mode === 'scheduled' && (!schedules || schedules.length === 0)
        ? DEFAULT_SCHEDULE
        : schedules;
      await setLaunchMode(machineId, processId, processName, mode, effectiveSchedules, schedulePresetId);
      const modeLabels = { off: 'Off', always: 'Always On', scheduled: 'Scheduled' };
      toast.success(`Launch mode set to ${modeLabels[mode]} for "${processName}"`);
    } catch (error: any) {
      console.error('handleSetLaunchMode error:', error);
      toast.error(error.message || 'Failed to set launch mode');
    }
  };

  const openEditProcessDialog = (machineId: string, process: any) => {
    setProcessDialogMode('edit');
    setEditingMachineId(machineId);
    setEditingProcessId(process.id);

    // Map legacy visibility values to new options (backward compatibility)
    let visibilityValue = process.visibility || 'Normal';
    if (visibilityValue === 'Show') {
      visibilityValue = 'Normal';
    } else if (visibilityValue === 'Hide') {
      visibilityValue = 'Hidden';
    }

    setEditProcessForm({
      name: process.name || '',
      exe_path: process.exe_path || '',
      file_path: process.file_path || '',
      cwd: process.cwd || '',
      priority: process.priority || 'Normal',
      visibility: visibilityValue,
      time_delay: process.time_delay || '0',
      time_to_init: process.time_to_init || '10',
      relaunch_attempts: process.relaunch_attempts || '3',
      autolaunch: process.autolaunch || false,
      launch_mode: process.launch_mode || (process.autolaunch ? 'always' : 'off'),
      schedules: process.schedules || null,
    });
    setProcessDialogOpen(true);
  };

  const openCreateProcessDialog = (machineId: string) => {
    setProcessDialogMode('create');
    setEditingMachineId(machineId);
    setEditingProcessId(''); // No process ID for new process
    // Reset form to defaults
    setEditProcessForm({
      name: '',
      exe_path: '',
      file_path: '',
      cwd: '',
      priority: 'Normal',
      visibility: 'Normal',
      time_delay: '0',
      time_to_init: '10',
      relaunch_attempts: '3',
      autolaunch: false,
      launch_mode: 'off' as LaunchMode,
      schedules: null as ScheduleBlock[] | null,
    });
    setProcessDialogOpen(true);
  };

  const handleSaveProcess = async () => {
    // Validation
    if (!editProcessForm.name || !editProcessForm.name.trim()) {
      toast.error('process name is required');
      return;
    }

    if (!editProcessForm.exe_path || !editProcessForm.exe_path.trim()) {
      toast.error('executable path is required');
      return;
    }

    try {
      if (processDialogMode === 'create') {
        // Create new process
        await createProcess(editingMachineId, editProcessForm);
        toast.success(`Process "${editProcessForm.name}" created successfully!`);
      } else {
        // Update existing process
        await updateProcess(editingMachineId, editingProcessId, editProcessForm);
        toast.success(`Process "${editProcessForm.name}" updated successfully!`);
      }
      setProcessDialogOpen(false);
    } catch (error: any) {
      toast.error(error.message || `Failed to ${processDialogMode} process`);
    }
  };

  const handleDeleteProcess = async () => {
    try {
      await deleteProcess(editingMachineId, editingProcessId);
      toast.success(`Process "${editProcessForm.name}" deleted successfully!`);
      setProcessDialogOpen(false);
      setDeleteConfirmOpen(false);
    } catch (error: any) {
      toast.error(error.message || 'Failed to delete process');
    }
  };

  const openRemoveMachineDialog = (machineId: string, machineName: string, isOnline: boolean) => {
    setMachineToRemove({ id: machineId, name: machineName, isOnline });
    setRemoveMachineDialogOpen(true);
  };

  const handleConfirmRemoveMachine = async () => {
    if (!machineToRemove) return;

    try {
      await removeMachineFromSite(machineToRemove.id);
      toast.success(`Machine "${machineToRemove.name}" removed from site successfully!`);
      setRemoveMachineDialogOpen(false);
      setMachineToRemove(null);
    } catch (error: any) {
      toast.error(error.message || 'Failed to remove machine');
    }
  };

  // Load view preference from localStorage
  useEffect(() => {
    const savedView = localStorage.getItem('owlette_view_type') as ViewType;
    if (savedView) {
      setViewType(savedView);
    }
  }, []);

  // Delay showing "Getting Started" by 2 seconds to avoid flash if machines load quickly
  useEffect(() => {
    const timer = setTimeout(() => {
      setCanShowGettingStarted(true);
    }, 2000); // 2 second delay
    return () => clearTimeout(timer);
  }, []);

  // Save view preference to localStorage
  const handleViewChange = (view: ViewType) => {
    setViewType(view);
    localStorage.setItem('owlette_view_type', view);
  };

  // Load saved site from Firestore (cross-browser) or localStorage (same-browser fallback)
  useEffect(() => {
    if (!sitesLoading && sites.length > 0 && !currentSiteId) {
      const savedSite = lastSiteId || localStorage.getItem('owlette_current_site');
      if (savedSite && sites.find(s => s.id === savedSite)) {
        setCurrentSiteId(savedSite);
      } else {
        setCurrentSiteId(sites[0].id);
      }
    }
  }, [sites, sitesLoading, currentSiteId, lastSiteId]);

  const handleSiteChange = (siteId: string) => {
    setCurrentSiteId(siteId);
    updateLastSite(siteId);
  };

  // Handle metric click to open detail panel
  const handleMetricClick = (machineId: string, metric: MetricType) => {
    const machine = machines.find(m => m.machineId === machineId);
    setDetailPanel({
      machineId,
      machineName: machine?.machineId || machineId,
      metric,
    });
  };

  // Close detail panel and return to stats cards
  const handleCloseDetailPanel = () => {
    setDetailPanel(null);
  };

  useEffect(() => {
    if (!loading && !user) {
      router.push('/');
    }
  }, [user, loading, router]);

  // 2FA Guard: Redirect users who need to complete 2FA setup
  useEffect(() => {
    if (!loading && user && requiresMfaSetup) {
      router.push('/setup-2fa');
    }
  }, [loading, user, requiresMfaSetup, router]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-muted-foreground">loading...</p>
      </div>
    );
  }

  if (!user) {
    return null;
  }

  const onlineMachines = machines.filter(m => m.online).length;
  const totalProcesses = machines.reduce((acc, m) => {
    return acc + (m.metrics?.processes ? Object.keys(m.metrics.processes).length : 0);
  }, 0);

  const currentSite = sites.find(s => s.id === currentSiteId);

  return (
    <div className="relative min-h-screen pb-24">
      {/* Header */}
      <PageHeader
        currentPage="dashboard"
        sites={sites}
        currentSiteId={currentSiteId}
        onSiteChange={handleSiteChange}
        onManageSites={() => setManageDialogOpen(true)}
        onAccountSettings={() => setAccountSettingsOpen(true)}
        actionButton={<DownloadButton />}
      />

      {/* Site Management Dialogs */}
      <ManageSitesDialog
        open={manageDialogOpen}
        onOpenChange={setManageDialogOpen}
        sites={sites}
        currentSiteId={currentSiteId}
        machineCount={machines.length}
        onUpdateSite={updateSite}
        onDeleteSite={async (siteId) => {
          await deleteSite(siteId);
          // If we deleted the current site, switch to another one
          if (siteId === currentSiteId) {
            const remainingSites = sites.filter(s => s.id !== siteId);
            if (remainingSites.length > 0) {
              handleSiteChange(remainingSites[0].id);
            }
          }
        }}
        onCreateSite={() => setCreateDialogOpen(true)}
      />

      <CreateSiteDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        onCreateSite={createSite}
        onSiteCreated={(siteId) => setCurrentSiteId(siteId)}
      />

      {/* Main content */}
      <main className="relative z-10 mx-auto max-w-screen-2xl p-3 md:p-4">
        <div className="mt-3 md:mt-2 mb-6 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div className="flex-1">
            <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground mb-1">
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="cursor-help">
                      {randomWelcome.text.toLowerCase()}{user.displayName ? `, ${user.displayName.split(' ')[0]}` : ''}!
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p className="font-semibold">{randomWelcome.language}</p>
                    <p className="text-xs text-foreground">{randomWelcome.translation}</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </h2>
            <p className="text-sm md:text-base text-muted-foreground">
              {randomJoke.toLowerCase()}
            </p>
          </div>

          {/* Quick stats - inline with welcome */}
          <div className="flex items-center gap-6 md:gap-8">
            {/* Machines / Online ratio */}
            <div className="flex items-center gap-2.5">
              <div className={`rounded-md p-1.5 ${onlineMachines > 0 ? 'bg-emerald-500/10 text-emerald-400' : 'bg-muted text-muted-foreground'}`}>
                <Monitor className="h-4 w-4" />
              </div>
              <div>
                <div className="flex items-baseline gap-0.5">
                  <span className={`text-xl font-bold ${onlineMachines > 0 ? 'text-emerald-400' : 'text-foreground'}`}>{onlineMachines}</span>
                  <span className="text-xs text-muted-foreground">/ {machines.length}</span>
                </div>
                <p className="text-[11px] text-muted-foreground leading-tight">online</p>
              </div>
            </div>

            {/* Divider */}
            <div className="h-8 w-px bg-border" />

            {/* Processes */}
            <div className="flex items-center gap-2.5">
              <div className="rounded-md p-1.5 bg-muted text-muted-foreground">
                <Cog className="h-4 w-4" />
              </div>
              <div>
                <div className="flex items-baseline gap-0.5">
                  <span className="text-xl font-bold text-foreground">{totalProcesses}</span>
                  <span className="text-xs text-muted-foreground">managed</span>
                </div>
                <p className="text-[11px] text-muted-foreground leading-tight">processes</p>
              </div>
            </div>
          </div>
        </div>

        {/* Metrics Detail Panel */}
        {detailPanel && (
          <div className="mb-6">
            <MetricsDetailPanel
              machineId={detailPanel.machineId}
              machineName={detailPanel.machineName}
              siteId={currentSiteId}
              initialMetric={detailPanel.metric}
              onClose={handleCloseDetailPanel}
            />
          </div>
        )}

        {/* Machines list */}
        {machines.length > 0 ? (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <h3 className="text-lg md:text-xl font-bold text-foreground">machines</h3>

              <div className="flex items-center gap-2">
                {/* Add Machine Button */}
                <AddMachineButton
                  currentSiteId={currentSiteId}
                  currentSiteName={currentSite?.name}
                />

                {/* Expand/Collapse All + View Toggle */}
                <div className="flex items-center gap-1 rounded-lg border border-border bg-muted p-1 select-none">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={toggleAllExpanded}
                    className="cursor-pointer text-muted-foreground hover:bg-secondary hover:text-foreground"
                    title={allExpanded ? 'collapse all' : 'expand all'}
                  >
                    {allExpanded ? <ChevronsDownUp className="h-4 w-4" /> : <ChevronsUpDown className="h-4 w-4" />}
                  </Button>
                  <div className="h-4 w-px bg-border" />
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleViewChange('card')}
                    className={`cursor-pointer ${viewType === 'card' ? 'bg-secondary text-accent-cyan' : 'text-muted-foreground hover:bg-secondary hover:text-foreground'}`}
                  >
                    <LayoutGrid className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleViewChange('list')}
                    className={`cursor-pointer ${viewType === 'list' ? 'bg-secondary text-accent-cyan' : 'text-muted-foreground hover:bg-secondary hover:text-foreground'}`}
                  >
                    <List className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </div>

            {/* Card View — only rendered when active */}
            {viewType === 'card' && (
              <div className="animate-in fade-in duration-300">
                <MachineCardView
                  machines={machines}
                  statsExpanded={userPreferences.statsExpanded}
                  processesExpanded={userPreferences.processesExpanded}
                  onToggleStats={toggleStatsExpanded}
                  onToggleProcesses={toggleProcessesExpanded}
                  currentSiteId={currentSiteId}
                  siteTimezone={currentSite?.timezone}
                  siteTimeFormat={currentSite?.timeFormat}
                  onEditProcess={openEditProcessDialog}
                  onCreateProcess={openCreateProcessDialog}
                  onKillProcess={handleKillProcess}
                  onSetLaunchMode={handleSetLaunchMode}
                  onConfigureSchedule={handleConfigureSchedule}
                  onRemoveMachine={openRemoveMachineDialog}
                  onMetricClick={handleMetricClick}
                  onReboot={rebootMachine}
                  onShutdown={shutdownMachine}
                  onCancelReboot={cancelReboot}
                  onDismissRebootPending={dismissRebootPending}
                  onScreenshot={(machineId) => {
                    const m = machines.find(m => m.machineId === machineId);
                    setScreenshotTarget({ machineId, machineName: machineId, isOnline: m?.online ?? false });
                    setScreenshotDialogOpen(true);
                  }}
                  onLiveView={(machineId) => {
                    setLiveViewTarget({ machineId, machineName: machineId });
                    setLiveViewOpen(true);
                  }}
                />
              </div>
            )}

            {/* List View — only rendered when active */}
            {viewType === 'list' && (
              <div className="rounded-lg border border-border bg-card overflow-hidden animate-in fade-in duration-300">
                <Table style={{ contain: 'layout', tableLayout: 'fixed' }}>
                  <ListViewTableHeader />
                  <TableBody>
                    {machines.map((machine) => (
                      <MachineRow
                        key={machine.machineId}
                        machine={machine}
                        isExpanded={expandedMachineIds.has(machine.machineId)}
                        currentSiteId={currentSiteId}
                        siteTimezone={currentSite?.timezone || 'UTC'}
                        siteTimeFormat={currentSite?.timeFormat || '12h'}
                        userPreferences={userPreferences}
                        isAdmin={isAdmin}
                        onToggleExpanded={() => toggleMachineExpanded(machine.machineId)}
                        onEditProcess={(process) => openEditProcessDialog(machine.machineId, process)}
                        onCreateProcess={() => openCreateProcessDialog(machine.machineId)}
                        onKillProcess={(processId, processName) => handleKillProcess(machine.machineId, processId, processName)}
                        onSetLaunchMode={(processId, processName, mode, exePath, schedules) =>
                          handleSetLaunchMode(machine.machineId, processId, processName, mode, exePath, schedules)
                        }
                        onConfigureSchedule={(process) => handleConfigureSchedule(machine.machineId, process)}
                        onRemoveMachine={() => openRemoveMachineDialog(machine.machineId, machine.machineId, machine.online)}
                        onMetricClick={(metricType) => handleMetricClick(machine.machineId, metricType)}
                        onReboot={() => rebootMachine(machine.machineId)}
                        onShutdown={() => shutdownMachine(machine.machineId)}
                        onScreenshot={() => {
                          setScreenshotTarget({ machineId: machine.machineId, machineName: machine.machineId, isOnline: machine.online });
                          setScreenshotDialogOpen(true);
                        }}
                        onLiveView={() => {
                          setLiveViewTarget({ machineId: machine.machineId, machineName: machine.machineId });
                          setLiveViewOpen(true);
                        }}
                      />
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
        ) : canShowGettingStarted ? (
          <Card className="border-border bg-card animate-in fade-in duration-500">
            <CardHeader>
              <CardTitle className="text-foreground">getting started</CardTitle>
              <CardDescription className="text-muted-foreground">
                connect your first machine to start managing processes
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Step 1: Create Your First Site (only shown when no sites exist) */}
              {sites.length === 0 && (
                <div className="rounded-lg border-2 border-accent-cyan bg-accent-cyan/10 p-6">
                  <h3 className="text-lg font-bold text-foreground mb-2">step 1: create your first site</h3>
                  <p className="text-sm text-foreground mb-4">
                    Sites organize your machines by location or purpose (e.g., &quot;NYC Office&quot;, &quot;Home Studio&quot;, &quot;Production Floor&quot;).
                    Create your first site to get started!
                  </p>
                  <Button
                    onClick={() => setCreateDialogOpen(true)}
                    className="bg-accent-cyan hover:bg-accent-cyan-hover text-gray-900 font-semibold px-6 py-3 cursor-pointer"
                  >
                    <Plus className="h-4 w-4 mr-2" />
                    create your first site
                  </Button>
                </div>
              )}

              {/* Steps 2-5: Only shown after site is created */}
              {sites.length > 0 && (
                <>
                  <div className="rounded-lg border border-border bg-background p-4">
                    <h3 className="font-semibold text-foreground mb-3">step 1: download owlette agent</h3>
                <p className="text-sm text-muted-foreground mb-4">
                  download and run the installer <strong className="text-foreground">on the machine you want to add</strong> (not necessarily this one).
                  use the copy link option if connecting via remote desktop tools like Parsec, TeamViewer, or RDP.
                </p>
                <div className="flex gap-2">
                  <Button
                    onClick={() => {
                      if (!downloadUrl) {
                        toast.error('download unavailable', {
                          description: 'installer download URL is not available.',
                        });
                        return;
                      }
                      try {
                        window.open(downloadUrl, '_blank');
                        toast.success('download started', {
                          description: `downloading Owlette v${version}`,
                        });
                      } catch (err) {
                        toast.error('download failed', {
                          description: 'failed to start download. please try again.',
                        });
                      }
                    }}
                    disabled={!downloadUrl}
                    className="flex-1 bg-accent-cyan hover:bg-accent-cyan-hover text-gray-900 cursor-pointer"
                  >
                    <Download className="h-4 w-4 mr-2" />
                    <span>download {version && `v${version}`}</span>
                  </Button>
                  <Button
                    onClick={() => {
                      if (!downloadUrl) {
                        toast.error('copy failed', {
                          description: 'download URL is not available.',
                        });
                        return;
                      }
                      try {
                        navigator.clipboard.writeText(downloadUrl);
                        toast.success('link copied', {
                          description: 'download link copied to clipboard',
                        });
                      } catch (err) {
                        toast.error('copy failed', {
                          description: 'failed to copy link. please try again.',
                        });
                      }
                    }}
                    disabled={!downloadUrl}
                    className="flex-1 bg-accent-cyan hover:bg-accent-cyan-hover text-gray-900 cursor-pointer"
                  >
                    <Copy className="h-4 w-4 mr-2" />
                    <span>copy link</span>
                  </Button>
                </div>
              </div>
              <div className="rounded-lg border border-border bg-background p-4">
                <h3 className="font-semibold text-foreground">step 2: run the installer</h3>
                <p className="text-sm text-muted-foreground">
                  on that machine, double-click the installer - it will automatically open a browser for authentication
                </p>
              </div>
              <div className="rounded-lg border border-border bg-background p-4">
                <h3 className="font-semibold text-foreground">step 3: authorize agent</h3>
                <p className="text-sm text-muted-foreground">
                  log in and authorize the agent for site <span className="font-mono text-accent-cyan">{currentSite?.name || currentSiteId}</span>
                </p>
              </div>
              <div className="rounded-lg border border-border bg-background p-4">
                <h3 className="font-semibold text-foreground">step 4: done!</h3>
                <p className="text-sm text-muted-foreground">
                  the installer completes automatically and that machine will appear above within seconds
                </p>
              </div>
                </>
              )}
            </CardContent>
          </Card>
        ) : null}
      </main>

      {/* Process Dialog (Create/Edit) */}
      <Dialog open={processDialogOpen} onOpenChange={setProcessDialogOpen}>
        <DialogContent className="border-border bg-muted text-foreground max-w-3xl">
          <DialogHeader>
            <DialogTitle className="text-foreground">
              {processDialogMode === 'create' ? 'add process' : 'edit process'}

            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {processDialogMode === 'create'
                ? 'add a process to this machine'
                : 'update process configuration'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            {/* Name */}
            <div className="space-y-2">
              <Label htmlFor="edit-name" className="text-foreground">name</Label>
              <Input
                id="edit-name"
                value={editProcessForm.name}
                onChange={(e) => setEditProcessForm({ ...editProcessForm, name: e.target.value })}
                className="border-border bg-card text-foreground"
              />
            </div>

            {/* Launch Mode — positioned prominently after name */}
            <div className="space-y-2">
              <Label className="text-foreground text-sm">launch mode</Label>
              <div className="flex rounded-lg overflow-hidden border border-border">
                {(['off', 'always', 'scheduled'] as const).map((mode) => {
                  const labels = { off: 'Off', always: 'Always On', scheduled: 'Scheduled' };
                  const isActive = editProcessForm.launch_mode === mode;
                  const colors = {
                    off: isActive ? 'bg-muted text-foreground' : '',
                    always: isActive ? 'bg-emerald-600 text-white' : '',
                    scheduled: isActive ? 'bg-blue-600 text-white' : '',
                  };

                  if (mode === 'scheduled' && isActive) {
                    return (
                      <span key={mode} className="flex items-stretch flex-1 bg-blue-600 text-white">
                        <button
                          type="button"
                          onClick={() => setEditProcessForm({ ...editProcessForm, launch_mode: mode, autolaunch: true })}
                          className="flex-1 px-3 py-1.5 text-xs font-medium cursor-pointer"
                        >
                          {labels[mode]}
                        </button>
                        <span className="w-px bg-blue-400/50" />
                        <button
                          type="button"
                          onClick={() => {
                            setProcessDialogOpen(false);
                            handleConfigureSchedule(editingMachineId, {
                              id: editingProcessId,
                              name: editProcessForm.name,
                              exe_path: editProcessForm.exe_path,
                              schedules: editProcessForm.schedules || null,
                              launch_mode: 'scheduled',
                            } as Process);
                          }}
                          className="px-1.5 hover:bg-blue-500 transition-colors cursor-pointer flex items-center"
                          title="configure schedule"
                        >
                          <Settings2 className="h-3.5 w-3.5" />
                        </button>
                      </span>
                    );
                  }

                  return (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setEditProcessForm({ ...editProcessForm, launch_mode: mode, autolaunch: mode !== 'off' })}
                      className={`flex-1 px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer ${colors[mode]} ${!isActive ? 'bg-card text-muted-foreground hover:bg-muted/50' : ''}`}
                    >
                      {labels[mode]}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Executable Path */}
            <div className="space-y-2">
              <Label htmlFor="edit-exe-path" className="text-foreground">executable path</Label>
              <Input
                id="edit-exe-path"
                value={editProcessForm.exe_path}
                onChange={(e) => setEditProcessForm({ ...editProcessForm, exe_path: e.target.value })}
                className="border-border bg-card text-foreground"
                placeholder="C:/Program Files/..."
              />
            </div>

            {/* File Path / Cmd Args */}
            <div className="space-y-2">
              <Label htmlFor="edit-file-path" className="text-foreground">file path / command arguments</Label>
              <Input
                id="edit-file-path"
                value={editProcessForm.file_path}
                onChange={(e) => setEditProcessForm({ ...editProcessForm, file_path: e.target.value })}
                className="border-border bg-card text-foreground"
                placeholder="optional"
              />
            </div>

            {/* Working Directory */}
            <div className="space-y-2">
              <Label htmlFor="edit-cwd" className="text-foreground">working directory</Label>
              <Input
                id="edit-cwd"
                value={editProcessForm.cwd}
                onChange={(e) => setEditProcessForm({ ...editProcessForm, cwd: e.target.value })}
                className="border-border bg-card text-foreground"
                placeholder="optional"
              />
            </div>

            <div className="grid grid-cols-3 gap-4">
              {/* Priority */}
              <div className="space-y-2">
                <Label htmlFor="edit-priority" className="text-foreground">task priority</Label>

                <Select
                  value={editProcessForm.priority}
                  onValueChange={(value) => setEditProcessForm({ ...editProcessForm, priority: value })}
                >
                  <SelectTrigger id="edit-priority" className="border-border bg-card text-foreground">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="border-border bg-card text-foreground">
                    <SelectItem value="Low">low</SelectItem>
                    <SelectItem value="Normal">normal</SelectItem>
                    <SelectItem value="High">high</SelectItem>
                    <SelectItem value="Realtime">realtime</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Visibility */}
              <div className="space-y-2">
                <Label htmlFor="edit-visibility" className="text-foreground">window visibility</Label>
                <Select
                  value={editProcessForm.visibility}
                  onValueChange={(value) => setEditProcessForm({ ...editProcessForm, visibility: value })}
                >
                  <SelectTrigger id="edit-visibility" className="border-border bg-card text-foreground">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="border-border bg-card text-foreground">
                    <SelectItem value="Normal">normal</SelectItem>
                    <SelectItem value="Hidden">hidden (console apps only)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Empty space for alignment */}
              <div></div>
            </div>

            <div className="grid grid-cols-3 gap-4">
              {/* Time Delay */}
              <div className="space-y-2">
                <Label htmlFor="edit-time-delay" className="text-foreground">launch delay (sec)</Label>
                <Input
                  id="edit-time-delay"
                  type="number"
                  value={editProcessForm.time_delay}
                  onChange={(e) => setEditProcessForm({ ...editProcessForm, time_delay: e.target.value })}
                  className="border-border bg-card text-foreground"
                />
              </div>

              {/* Time to Init */}
              <div className="space-y-2">
                <Label htmlFor="edit-time-init" className="text-foreground">init timeout (sec)</Label>
                <Input
                  id="edit-time-init"
                  type="number"
                  value={editProcessForm.time_to_init}
                  onChange={(e) => setEditProcessForm({ ...editProcessForm, time_to_init: e.target.value })}
                  className="border-border bg-card text-foreground"
                />
              </div>

              {/* Relaunch Attempts */}
              <div className="space-y-2">
                <Label htmlFor="edit-relaunch" className="text-foreground">relaunch attempts</Label>
                <Input
                  id="edit-relaunch"
                  type="number"
                  value={editProcessForm.relaunch_attempts}
                  onChange={(e) => setEditProcessForm({ ...editProcessForm, relaunch_attempts: e.target.value })}
                  className="border-border bg-card text-foreground"
                />
              </div>
            </div>

          </div>
          <DialogFooter className="flex items-center">
            {processDialogMode === 'edit' && (
              <Button
                variant="ghost"
                onClick={() => setDeleteConfirmOpen(true)}
                className="text-red-400 hover:text-red-300 hover:bg-red-950/30 cursor-pointer"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            )}
            <div className="flex gap-2 ml-auto">
              <Button
                variant="outline"
                onClick={() => setProcessDialogOpen(false)}
                className="border-border bg-muted text-foreground hover:bg-accent hover:border-foreground/30 hover:text-white cursor-pointer"
              >
                cancel
              </Button>
              <Button
                onClick={handleSaveProcess}
                className="bg-accent-cyan hover:bg-accent-cyan-hover text-gray-900 cursor-pointer"
              >
                {processDialogMode === 'create' ? 'create process' : 'save changes'}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Process Confirmation Dialog */}
      <Dialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <DialogContent className="border-border bg-muted text-foreground">
          <DialogHeader>
            <DialogTitle className="text-foreground">delete process</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              are you sure you want to permanently delete "{editProcessForm.name}"? this action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteConfirmOpen(false)}
              className="border-border bg-muted text-foreground hover:bg-accent hover:border-foreground/30 hover:text-white cursor-pointer"
            >
              cancel
            </Button>
            <Button
              onClick={handleDeleteProcess}
              className="bg-red-600 hover:bg-red-700 text-foreground cursor-pointer"
            >
              delete process
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Account Settings Dialog */}
      <AccountSettingsDialog
        open={accountSettingsOpen}
        onOpenChange={setAccountSettingsOpen}
      />

      {/* Remove Machine Dialog */}
      {machineToRemove && (
        <RemoveMachineDialog
          open={removeMachineDialogOpen}
          onOpenChange={setRemoveMachineDialogOpen}
          machineId={machineToRemove.id}
          machineName={machineToRemove.name}
          isOnline={machineToRemove.isOnline}
          hasActiveDeployments={checkMachineHasActiveDeployment(machineToRemove.id)}
          isRemoving={isRemovingMachine}
          onConfirmRemove={handleConfirmRemoveMachine}
        />
      )}

      {/* Kill Process Confirmation Dialog */}
      <Dialog open={killConfirmOpen} onOpenChange={setKillConfirmOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>kill process</DialogTitle>
            <DialogDescription>
              are you sure you want to kill <span className="font-semibold text-foreground">{killTarget?.processName}</span>? this will immediately terminate the process.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setKillConfirmOpen(false)}
            >
              cancel
            </Button>
            <Button
              variant="destructive"
              onClick={confirmKillProcess}
            >
              <Square className="h-4 w-4 mr-2" />
              kill process
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Schedule Editor Dialog — only mounted when open for fresh state each time */}
      {scheduleEditorOpen && scheduleEditorTarget && (
        <ScheduleEditor
          open
          onOpenChange={(open) => {
            setScheduleEditorOpen(open);
            if (!open) setScheduleEditorTarget(null);
          }}
          schedules={scheduleEditorTarget.process._optimisticSchedules ?? scheduleEditorTarget.process.schedules ?? null}
          initialPresetId={scheduleEditorTarget.process._optimisticPresetId ?? scheduleEditorTarget.process.schedulePresetId}
          onChange={handleScheduleApply}
          siteTimezone={currentSite?.timezone}
          presets={schedulePresets}
          onCreatePreset={handleCreatePreset}
          onDeletePreset={async (id) => { await deleteSchedulePreset(id); toast.success('Preset deleted'); }}
          onUpdatePreset={async (id, updates) => { await updateSchedulePreset(id, updates); toast.success('Preset updated'); }}
        />
      )}

      {/* Screenshot Dialog */}
      {screenshotTarget && (
        <ScreenshotDialog
          open={screenshotDialogOpen}
          onOpenChange={setScreenshotDialogOpen}
          machineId={screenshotTarget.machineId}
          machineName={screenshotTarget.machineName}
          siteId={currentSiteId}
          isOnline={screenshotTarget.isOnline}
          onCaptureScreenshot={() => captureScreenshot(screenshotTarget.machineId)}
          lastScreenshot={machines.find(m => m.machineId === screenshotTarget.machineId)?.lastScreenshot}
          hasActiveDeployment={checkMachineHasActiveDeployment(screenshotTarget.machineId)}
        />
      )}

      {/* Live View Modal */}
      {liveViewTarget && (
        <LiveViewModal
          open={liveViewOpen}
          onOpenChange={setLiveViewOpen}
          siteId={currentSiteId}
          machineId={liveViewTarget.machineId}
          machineName={liveViewTarget.machineName}
          onStartLiveView={startLiveView}
          onStopLiveView={stopLiveView}
        />
      )}
    </div>
  );
}
