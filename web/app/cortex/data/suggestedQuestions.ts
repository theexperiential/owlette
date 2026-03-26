export type QuestionCategory =
  | 'system-health'
  | 'gpu-display'
  | 'process-management'
  | 'network-connectivity'
  | 'storage-files'
  | 'troubleshooting'
  | 'scheduling-automation'
  | 'security-events'
  | 'performance'
  | 'installation-config';

export interface SuggestedQuestion {
  text: string;
  category: QuestionCategory;
}

export const SUGGESTED_QUESTIONS: SuggestedQuestion[] = [
  // ── system-health ──────────────────────────────────────────────────────
  { text: 'when was the last time this machine rebooted?', category: 'system-health' },
  { text: 'how much RAM is being used right now?', category: 'system-health' },
  { text: 'give me a full system health report', category: 'system-health' },
  { text: 'what OS version is this machine running?', category: 'system-health' },
  { text: 'how long has this machine been up without a restart?', category: 'system-health' },
  { text: 'is the Owlette agent healthy and connected?', category: 'system-health' },
  { text: 'what CPU is in this machine and how hard is it working?', category: 'system-health' },
  { text: 'show me overall system resource usage', category: 'system-health' },
  { text: 'what\'s the current CPU temperature?', category: 'system-health' },
  { text: 'how many CPU cores does this machine have?', category: 'system-health' },
  { text: 'is this machine running Windows 10 or 11?', category: 'system-health' },
  { text: 'what\'s the total physical memory installed?', category: 'system-health' },
  { text: 'has the agent been restarting unexpectedly?', category: 'system-health' },
  { text: 'when did the Owlette agent last come online?', category: 'system-health' },
  { text: 'is this machine healthy enough to run a show tonight?', category: 'system-health' },
  { text: 'give me a quick pre-show system check', category: 'system-health' },
  { text: 'are there any red flags in the system health right now?', category: 'system-health' },
  { text: 'what version of the Owlette agent is running?', category: 'system-health' },
  { text: 'how much memory is available for new processes?', category: 'system-health' },
  { text: 'summarize the current state of this machine', category: 'system-health' },

  // ── gpu-display ────────────────────────────────────────────────────────
  { text: 'which nvidia driver version is installed?', category: 'gpu-display' },
  { text: 'how much VRAM is free right now?', category: 'gpu-display' },
  { text: 'take a screenshot so I can see what\'s on screen', category: 'gpu-display' },
  { text: 'is the GPU under heavy load right now?', category: 'gpu-display' },
  { text: 'run nvidia-smi and show me the full output', category: 'gpu-display' },
  { text: 'what GPU model is in this machine?', category: 'gpu-display' },
  { text: 'check if the displays are showing the right content', category: 'gpu-display' },
  { text: 'is the GPU running hot?', category: 'gpu-display' },
  { text: 'what\'s the current GPU temperature?', category: 'gpu-display' },
  { text: 'which process is using the most VRAM?', category: 'gpu-display' },
  { text: 'are all display outputs active?', category: 'gpu-display' },
  { text: 'take a screenshot of monitor 2', category: 'gpu-display' },
  { text: 'is the GPU memory getting close to full?', category: 'gpu-display' },
  { text: 'what resolution are the connected displays running at?', category: 'gpu-display' },
  { text: 'show me the GPU utilization percentage', category: 'gpu-display' },
  { text: 'is the display output frozen or updating normally?', category: 'gpu-display' },
  { text: 'capture all monitors so I can see the full output', category: 'gpu-display' },
  { text: 'what\'s the GPU clock speed right now?', category: 'gpu-display' },
  { text: 'is the GPU driver up to date for this card?', category: 'gpu-display' },
  { text: 'how many displays are connected to this machine?', category: 'gpu-display' },
  { text: 'does the screen look right? take a screenshot and check', category: 'gpu-display' },
  { text: 'is VRAM usage climbing over time?', category: 'gpu-display' },
  { text: 'show me what\'s on screen right now', category: 'gpu-display' },
  { text: 'how much total VRAM does this GPU have?', category: 'gpu-display' },
  { text: 'are the GPU fans spinning at a normal speed?', category: 'gpu-display' },

  // ── process-management ─────────────────────────────────────────────────
  { text: 'what processes is Owlette managing right now?', category: 'process-management' },
  { text: 'restart the main process for me', category: 'process-management' },
  { text: 'are all configured processes currently running?', category: 'process-management' },
  { text: 'which configured processes are currently stopped?', category: 'process-management' },
  { text: 'set all processes to always-on mode', category: 'process-management' },
  { text: 'show me the PID and status of every managed process', category: 'process-management' },
  { text: 'one of the processes looks frozen — restart it', category: 'process-management' },
  { text: 'kill the hung process and restart it cleanly', category: 'process-management' },
  { text: 'is the main process responding or is it frozen?', category: 'process-management' },
  { text: 'start up all the managed processes', category: 'process-management' },
  { text: 'stop all running processes for maintenance', category: 'process-management' },
  { text: 'has any managed process crashed recently?', category: 'process-management' },
  { text: 'what launch mode is each process set to?', category: 'process-management' },
  { text: 'how many times has a process been auto-restarted today?', category: 'process-management' },
  { text: 'turn off autolaunch for all processes temporarily', category: 'process-management' },
  { text: 'which processes have crash recovery enabled?', category: 'process-management' },
  { text: 'restart everything — the whole installation needs a fresh start', category: 'process-management' },
  { text: 'is any managed process using an unusual amount of memory?', category: 'process-management' },
  { text: 'show me how long each managed process has been running', category: 'process-management' },
  { text: 'are any processes stuck in a crash-restart loop?', category: 'process-management' },

  // ── network-connectivity ───────────────────────────────────────────────
  { text: 'what does the network config look like?', category: 'network-connectivity' },
  { text: 'what\'s the IP address of this machine?', category: 'network-connectivity' },
  { text: 'can this machine reach the internet?', category: 'network-connectivity' },
  { text: 'show me all network interfaces and their status', category: 'network-connectivity' },
  { text: 'is the ethernet link up or down?', category: 'network-connectivity' },
  { text: 'what DNS servers is this machine using?', category: 'network-connectivity' },
  { text: 'ping google and tell me the latency', category: 'network-connectivity' },
  { text: 'is the network interface getting good throughput?', category: 'network-connectivity' },
  { text: 'what\'s the gateway IP for this machine?', category: 'network-connectivity' },
  { text: 'are there any network errors or dropped packets?', category: 'network-connectivity' },
  { text: 'what\'s the link speed on the primary network adapter?', category: 'network-connectivity' },
  { text: 'is the WiFi connected or are we on ethernet?', category: 'network-connectivity' },
  { text: 'what subnet is this machine on?', category: 'network-connectivity' },
  { text: 'is there any packet loss on the primary interface?', category: 'network-connectivity' },
  { text: 'run a traceroute to 8.8.8.8', category: 'network-connectivity' },
  { text: 'are all network adapters showing link up?', category: 'network-connectivity' },
  { text: 'what\'s the current network utilization?', category: 'network-connectivity' },
  { text: 'is the machine getting a DHCP address or is it static?', category: 'network-connectivity' },
  { text: 'check if port 80 and 443 are open outbound', category: 'network-connectivity' },
  { text: 'how many network adapters does this machine have?', category: 'network-connectivity' },

  // ── storage-files ──────────────────────────────────────────────────────
  { text: 'how much disk space is left on C:?', category: 'storage-files' },
  { text: 'show me disk usage across all drives', category: 'storage-files' },
  { text: 'which drive is running low on space?', category: 'storage-files' },
  { text: 'what\'s the total storage capacity of this machine?', category: 'storage-files' },
  { text: 'how much free space is on each drive?', category: 'storage-files' },
  { text: 'what\'s in the startup folder for this user?', category: 'storage-files' },
  { text: 'how much free space is on the SSD?', category: 'storage-files' },
  { text: 'show me the largest files on the C: drive', category: 'storage-files' },
  { text: 'what\'s using the most disk space on C:?', category: 'storage-files' },
  { text: 'list all files modified in the last 24 hours', category: 'storage-files' },
  { text: 'is the log folder growing out of control?', category: 'storage-files' },
  { text: 'are there any crash dump files taking up space?', category: 'storage-files' },
  { text: 'what file systems are the drives formatted with?', category: 'storage-files' },
  { text: 'show me what\'s in the ProgramData\\Owlette folder', category: 'storage-files' },
  { text: 'is disk space trending down over time?', category: 'storage-files' },
  { text: 'how many drives are connected to this machine?', category: 'storage-files' },
  { text: 'check if any drive is above 90% usage', category: 'storage-files' },
  { text: 'are there any old log files that can be cleaned up?', category: 'storage-files' },
  { text: 'what\'s the read/write speed of the main drive?', category: 'storage-files' },
  { text: 'list the contents of the desktop folder', category: 'storage-files' },

  // ── troubleshooting ────────────────────────────────────────────────────
  { text: 'are there any recent application crashes in the event log?', category: 'troubleshooting' },
  { text: 'show me the last 20 error-level events from Windows', category: 'troubleshooting' },
  { text: 'why did the agent restart recently?', category: 'troubleshooting' },
  { text: 'check for any critical errors in the system event log', category: 'troubleshooting' },
  { text: 'what\'s eating all the memory on this machine?', category: 'troubleshooting' },
  { text: 'is anything pegging the CPU at 100%?', category: 'troubleshooting' },
  { text: 'show me the agent\'s recent error logs', category: 'troubleshooting' },
  { text: 'has any managed process crashed in the last 24 hours?', category: 'troubleshooting' },
  { text: 'check the site logs for any errors across all machines', category: 'troubleshooting' },
  { text: 'why is the display showing a black screen?', category: 'troubleshooting' },
  { text: 'what caused the last system crash?', category: 'troubleshooting' },
  { text: 'is there a memory leak — check process memory over time', category: 'troubleshooting' },
  { text: 'why is this machine running so slowly today?', category: 'troubleshooting' },
  { text: 'check if there are any Windows Update failures', category: 'troubleshooting' },
  { text: 'did any process exit with an error recently?', category: 'troubleshooting' },
  { text: 'are there any disk errors in the system log?', category: 'troubleshooting' },
  { text: 'what happened right before the screen froze?', category: 'troubleshooting' },
  { text: 'is the process crashing on startup or after running a while?', category: 'troubleshooting' },
  { text: 'check if a Windows update rebooted the machine overnight', category: 'troubleshooting' },
  { text: 'why did the main process stop responding?', category: 'troubleshooting' },
  { text: 'investigate why the display output went blank', category: 'troubleshooting' },
  { text: 'are there any hardware errors in the event log?', category: 'troubleshooting' },
  { text: 'what process is causing the GPU to max out?', category: 'troubleshooting' },
  { text: 'check if the machine ran out of VRAM', category: 'troubleshooting' },
  { text: 'did anything unusual happen in the last hour?', category: 'troubleshooting' },

  // ── scheduling-automation ──────────────────────────────────────────────
  { text: 'set all processes to only run weekdays 9am to 6pm', category: 'scheduling-automation' },
  { text: 'what\'s the current launch schedule for each process?', category: 'scheduling-automation' },
  { text: 'switch all processes to always-on mode', category: 'scheduling-automation' },
  { text: 'set up a weekend schedule: Saturday and Sunday 10am to 8pm', category: 'scheduling-automation' },
  { text: 'show me the current Owlette agent configuration', category: 'scheduling-automation' },
  { text: 'set up a Tuesday through Sunday 10am to 5pm schedule', category: 'scheduling-automation' },
  { text: 'set all managed processes to run 24/7', category: 'scheduling-automation' },
  { text: 'set processes to stop at midnight and start at 6am', category: 'scheduling-automation' },
  { text: 'set up a Friday through Sunday 6pm to 11pm schedule', category: 'scheduling-automation' },
  { text: 'what time windows are configured for each process?', category: 'scheduling-automation' },
  { text: 'disable all schedules and switch to manual control', category: 'scheduling-automation' },
  { text: 'set up a Monday through Friday 8am to 10pm schedule', category: 'scheduling-automation' },
  { text: 'are any processes set to launch on a schedule?', category: 'scheduling-automation' },
  { text: 'set processes to run every day from 7am to 11pm', category: 'scheduling-automation' },
  { text: 'turn off autolaunch for all processes during maintenance', category: 'scheduling-automation' },
  { text: 'set up a weekday 7am to 7pm schedule', category: 'scheduling-automation' },
  { text: 'set up a Thursday through Saturday 6pm to midnight schedule', category: 'scheduling-automation' },
  { text: 'configure weekend-only hours: 10am to 4pm Saturday and Sunday', category: 'scheduling-automation' },

  // ── security-events ────────────────────────────────────────────────────
  { text: 'any failed login attempts in the security log?', category: 'security-events' },
  { text: 'show me recent security events', category: 'security-events' },
  { text: 'is the Windows Firewall service running?', category: 'security-events' },
  { text: 'check if Windows Defender is active', category: 'security-events' },
  { text: 'who logged into this machine recently?', category: 'security-events' },
  { text: 'has anyone tried to remote desktop into this machine?', category: 'security-events' },
  { text: 'are there any suspicious security events in the last 24 hours?', category: 'security-events' },
  { text: 'is the Windows Update service running?', category: 'security-events' },
  { text: 'check if any new user accounts were created recently', category: 'security-events' },
  { text: 'are all critical Windows services running?', category: 'security-events' },
  { text: 'is remote desktop enabled on this machine?', category: 'security-events' },
  { text: 'check the security log for any privilege escalation events', category: 'security-events' },
  { text: 'was this machine accessed outside of normal hours?', category: 'security-events' },
  { text: 'is this machine locked down for unattended operation?', category: 'security-events' },
  { text: 'check if any unauthorized software was installed', category: 'security-events' },

  // ── performance ────────────────────────────────────────────────────────
  { text: 'which processes are using the most CPU?', category: 'performance' },
  { text: 'run a quick CPU and memory stress test', category: 'performance' },
  { text: 'is anything causing memory pressure?', category: 'performance' },
  { text: 'show me the top 10 processes by memory usage', category: 'performance' },
  { text: 'which process is hogging the most resources?', category: 'performance' },
  { text: 'compare CPU and GPU utilization side by side', category: 'performance' },
  { text: 'is the system under enough load to cause frame drops?', category: 'performance' },
  { text: 'what\'s the current CPU usage breakdown by process?', category: 'performance' },
  { text: 'is the system thermal throttling the GPU?', category: 'performance' },
  { text: 'how much system overhead is running outside of managed processes?', category: 'performance' },
  { text: 'are there any background processes slowing things down?', category: 'performance' },
  { text: 'check if antivirus scans are impacting performance', category: 'performance' },
  { text: 'is Windows indexing eating CPU in the background?', category: 'performance' },
  { text: 'how is the system performing compared to idle baseline?', category: 'performance' },
  { text: 'are there any runaway processes consuming resources?', category: 'performance' },
  { text: 'check if the page file is being used heavily', category: 'performance' },
  { text: 'is the GPU keeping up with the workload?', category: 'performance' },
  { text: 'show me a breakdown of what\'s using the GPU right now', category: 'performance' },
  { text: 'how much CPU headroom does this machine have?', category: 'performance' },
  { text: 'is disk I/O causing any bottlenecks?', category: 'performance' },

  // ── installation-config ────────────────────────────────────────────────
  { text: 'what version of the Owlette agent is installed?', category: 'installation-config' },
  { text: 'show me the agent\'s current config', category: 'installation-config' },
  { text: 'list all installed software on this machine', category: 'installation-config' },
  { text: 'what Python version is the agent running?', category: 'installation-config' },
  { text: 'what DirectX version is installed?', category: 'installation-config' },
  { text: 'check if .NET runtime is installed', category: 'installation-config' },
  { text: 'check if Visual C++ redistributables are installed', category: 'installation-config' },
  { text: 'is ffmpeg available on this system?', category: 'installation-config' },
  { text: 'show me the Owlette agent config file', category: 'installation-config' },
  { text: 'what processes are configured in Owlette?', category: 'installation-config' },
  { text: 'is the machine set up for auto-login?', category: 'installation-config' },
  { text: 'what startup programs are configured on this machine?', category: 'installation-config' },
  { text: 'is the machine configured for unattended operation?', category: 'installation-config' },
  { text: 'what media codecs are installed on this system?', category: 'installation-config' },
  { text: 'show me the Windows power plan settings', category: 'installation-config' },
  { text: 'is sleep and hibernate disabled on this machine?', category: 'installation-config' },
  { text: 'what Windows features and roles are installed?', category: 'installation-config' },
  { text: 'check if the machine is set to auto-restart after power loss', category: 'installation-config' },
  { text: 'is Windows Update set to auto-install?', category: 'installation-config' },
  { text: 'what user account is this machine logged in as?', category: 'installation-config' },
];

/**
 * Pick N random questions ensuring each comes from a different category.
 * Shuffles categories, picks one random question per category, then shuffles the result.
 */
export function getRandomSuggestions(count: number = 4): SuggestedQuestion[] {
  // Group by category
  const byCategory = new Map<QuestionCategory, SuggestedQuestion[]>();
  for (const q of SUGGESTED_QUESTIONS) {
    const list = byCategory.get(q.category);
    if (list) {
      list.push(q);
    } else {
      byCategory.set(q.category, [q]);
    }
  }

  // Shuffle category keys
  const categories = [...byCategory.keys()];
  for (let i = categories.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [categories[i], categories[j]] = [categories[j], categories[i]];
  }

  // Pick one random question from each of the first N categories
  const picks: SuggestedQuestion[] = [];
  for (let i = 0; i < Math.min(count, categories.length); i++) {
    const pool = byCategory.get(categories[i])!;
    picks.push(pool[Math.floor(Math.random() * pool.length)]);
  }

  // Shuffle the final picks
  for (let i = picks.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [picks[i], picks[j]] = [picks[j], picks[i]];
  }

  return picks;
}
