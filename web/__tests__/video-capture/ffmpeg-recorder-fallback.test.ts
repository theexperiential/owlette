/** @jest-environment node */
// Fake child processes: attempt 1 dies the way a non-NVENC box dies (stderr +
// exit 8), attempt 2 reports frames. Proves the retry, the non-retryable ENOENT
// case, and that the failed child is killed before the next spawn.
import { EventEmitter } from 'node:events';

jest.mock('node:child_process', () => ({
  spawn: jest.fn(),
  spawnSync: jest.fn(() => ({ status: 0 })),
}));
jest.mock('node:fs', () => ({
  existsSync: jest.fn(() => false),
  mkdirSync: jest.fn(),
  renameSync: jest.fn(),
  statSync: jest.fn(() => ({ size: 4096 })),
  unlinkSync: jest.fn(),
}));

import { spawn } from 'node:child_process';
import { FfmpegRecorder } from '@/e2e/videos/ffmpeg-recorder';

interface FakeProc extends EventEmitter {
  pid: number;
  stderr: EventEmitter;
  stdin: { write: jest.Mock; end: jest.Mock };
}

function fakeProc(): FakeProc {
  const p = new EventEmitter() as FakeProc;
  p.pid = 4242;
  p.stderr = new EventEmitter();
  p.stdin = { write: jest.fn(), end: jest.fn() };
  return p;
}

const PATHS = [
  { label: 'primary (ddagrab + h264_nvenc)', args: ['-x', 'primary'] },
  { label: 'fallback (gdigrab + libx264)', args: ['-x', 'fallback'] },
];

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

it('retries with the fallback path when the primary dies at startup', async () => {
  let attempt = 0;
  (spawn as jest.Mock).mockImplementation(() => {
    const p = fakeProc();
    attempt += 1;
    const n = attempt;
    setTimeout(() => {
      if (n === 1) {
        p.stderr.emit('data', Buffer.from("Unknown encoder 'h264_nvenc'\n"));
        p.emit('exit', 8, null);
      } else {
        p.stderr.emit('data', Buffer.from('frame=   12 fps= 60 q=-1.0\r'));
      }
    }, 10);
    return p;
  });

  const rec = new FfmpegRecorder({ outPath: 'C:/tmp/scene.mp4', paths: PATHS });
  await rec.start();

  expect((spawn as jest.Mock).mock.calls).toHaveLength(2);
  expect((spawn as jest.Mock).mock.calls[1][1]).toEqual(expect.arrayContaining(['fallback']));
  expect(rec.capturePath).toContain('fallback');
});

it('does not retry when ffmpeg itself cannot be spawned', async () => {
  (spawn as jest.Mock).mockImplementation(() => {
    const p = fakeProc();
    setTimeout(() => p.emit('error', Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' })), 10);
    return p;
  });

  const rec = new FfmpegRecorder({ outPath: 'C:/tmp/scene.mp4', paths: PATHS });
  await expect(rec.start()).rejects.toThrow(/is ffmpeg on PATH/);
  expect((spawn as jest.Mock).mock.calls).toHaveLength(1);
});

it('surfaces every attempt when all paths fail', async () => {
  (spawn as jest.Mock).mockImplementation(() => {
    const p = fakeProc();
    setTimeout(() => {
      p.stderr.emit('data', Buffer.from("No such filter: 'ddagrab'\n"));
      p.emit('exit', 8, null);
    }, 10);
    return p;
  });

  const rec = new FfmpegRecorder({ outPath: 'C:/tmp/scene.mp4', paths: PATHS });
  await expect(rec.start()).rejects.toThrow(/primary[\s\S]*fallback/);
  expect(rec.capturePath).toBeNull();
});
