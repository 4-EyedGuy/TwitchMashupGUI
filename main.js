// main.js
import { app, BrowserWindow, ipcMain } from 'electron';
import { spawn } from 'child_process';
import { execa } from 'execa';
import { readFileSync } from 'fs';
import { join } from 'path';
let autoUpdater = null;

let mainWindow;
let ffmpegProcess = null;
let isStopping = false;
const OUTPUT_FILE = 'twitch_mashup.mp3';


let config = { clientId: '', accessToken: '' };
try {
    const configPath = join(app.getAppPath(), 'config.json');
    const configData = readFileSync(configPath, 'utf-8');
    config = JSON.parse(configData);
} catch (error) {
    console.log('Config not found, using empty values');
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 850,
        minWidth: 1200,
        minHeight: 820,
        backgroundColor: '#121214',
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            webSecurity: false
        }
    });

    mainWindow.webContents.session.webRequest.onHeadersReceived(
        (details, callback) => {
            callback({
                responseHeaders: {
                    ...details.responseHeaders,
                    'Content-Security-Policy': ['']
                }
            });
        }
    );

    mainWindow.loadFile('index-electron.html');

    // ── DevTools ──────────────────────────────────────────────
    mainWindow.webContents.openDevTools();
    
    mainWindow.webContents.on('did-finish-load', () => {
        mainWindow.webContents.send('load-config', config);
    });
}

app.whenReady().then(() => {
    createWindow();
    setupAutoUpdater();
});

async function setupAutoUpdater() {
    try {
        const updaterModule = await import('electron-updater');
        autoUpdater = updaterModule.autoUpdater ?? updaterModule.default?.autoUpdater ?? updaterModule.default;
    } catch (err) {
        console.error('[Updater] Could not load electron-updater:', err.message);
        return;
    }

    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('checking-for-update', () => {
        console.log('[Updater] Checking for update...');
    });

    autoUpdater.on('update-available', (info) => {
        console.log(`[Updater] Update available: ${info.version}`);
        mainWindow.webContents.send('update-status', {
            type: 'available',
            version: info.version
        });
    });

    autoUpdater.on('update-not-available', () => {
        console.log('[Updater] Up to date.');
    });

    autoUpdater.on('download-progress', (progress) => {
        const pct = Math.round(progress.percent);
        mainWindow.webContents.send('update-status', {
            type: 'downloading',
            percent: pct,
            transferred: progress.transferred,
            total: progress.total
        });
    });

    autoUpdater.on('update-downloaded', (info) => {
        console.log(`[Updater] Update downloaded: ${info.version}`);
        mainWindow.webContents.send('update-status', {
            type: 'ready',
            version: info.version
        });
    });

    autoUpdater.on('error', (err) => {
        console.error('[Updater] Error:', err.message);
    });

    autoUpdater.checkForUpdates().catch(err => console.error('[Updater]', err.message));
    setInterval(() => {
        autoUpdater.checkForUpdates().catch(err => console.error('[Updater]', err.message));
    }, 30 * 60 * 1000);
}

async function getAudioUrl(streamer) {
    try {
        const result = await execa('streamlink', [
            'twitch.tv/' + streamer,
            'audio_only',
            '--stream-url'
        ]);

        return result.stdout.trim();
    } catch (error) {
        console.error(error);
        return null;
    }
}

async function getVideoUrl(streamer) {
    try {
        const qualities = [
            '1080p60',
            '1080p',
            '720p60',
            '720p',
            'best'
        ];

        for (const q of qualities) {
            try {
                const result = await execa('streamlink', [
                    'twitch.tv/' + streamer,
                    q,
                    '--stream-url'
                ]);

                const url = result.stdout.trim();
                if (url) return url;

            } catch {}
        }

        return null;

    } catch (error) {
        console.error(error);
        return null;
    }
}

ipcMain.on('start-mashup', async (event, streamers) => {
    if (ffmpegProcess) {
        isStopping = true;
        ffmpegProcess.kill('SIGKILL');
        ffmpegProcess = null;
    }
    isStopping = false;

    console.log(`[Mashup] Starting mashup for ${streamers.join(', ')}...`);
    event.reply('status-update', '🔍 Checking streams via Streamlink...');
    event.reply('check-progress-init', streamers);

    const urls = await Promise.all(streamers.map(async (streamer) => {
        const url = await getAudioUrl(streamer);
        if (!isStopping) {
            event.reply('check-progress-result', { streamer, online: url !== null });
        }
        return url;
    }));

    if (isStopping) return;

    const activeUrls = urls.filter(url => url !== null);

    console.log(`[Mashup] Got ${activeUrls.length} active streams out of ${streamers.length}`);

    if (activeUrls.length < 2) {
        console.error('[Mashup] At least 2 active streams required!');
        event.reply('status-update', '❌ Error: At least 2 active streams required!');
        return;
    }

    if (activeUrls.length > 0) {
        const onlineStreamers = streamers.filter((s, i) => urls[i] !== null);
        event.reply('status-update', `📺 Fetching video URLs (0/${onlineStreamers.length})...`);

        const videoUrls = {};
        let fetched = 0;
        for (const streamer of streamers) {
            if (isStopping) return;
            if (urls[streamers.indexOf(streamer)] === null) {
                event.reply('video-url-progress', { streamer, done: true, skipped: true });
                continue;
            }
            event.reply('video-url-progress', { streamer, done: false });
            const url = await getVideoUrl(streamer);
            fetched++;
            videoUrls[streamer] = url;
            event.reply('video-url-progress', { streamer, done: true, found: url !== null });
            event.reply('status-update', `📺 Fetching video URLs (${fetched}/${onlineStreamers.length})...`);
        }
        if (isStopping) return;
        event.reply('video-urls', videoUrls);
    }

    if (isStopping) return;

    console.log(`[Mashup] Starting audio mix for ${activeUrls.length} streams...`);
    event.reply('ffmpeg-ready', true);
    event.reply('status-update', '🎙 Streams found: ' + activeUrls.length + '. Starting mix...');

    const ffmpegArgs = [];
    activeUrls.forEach(url => {
        ffmpegArgs.push('-i', url);
    });
    
    ffmpegArgs.push(
        '-filter_complex', 'amix=inputs=' + activeUrls.length + ':duration=longest:dropout_transition=0',
        '-ac', '2',
        '-b:a', '192k',
        '-y', OUTPUT_FILE
    );

    ffmpegProcess = spawn('ffmpeg', ffmpegArgs);
    let ffmpegRecordingStarted = false;

    console.log('[FFmpeg] ffmpeg process started');

    ffmpegProcess.on('error', (error) => {
        console.error('[FFmpeg] Failed to start:', error.message);
        if (error.code === 'ENOENT') {
            console.error('[FFmpeg] FFmpeg not found! Install it: choco install ffmpeg');
            event.reply('status-update', '❌ FFmpeg not found. Install it with: choco install ffmpeg');
        }
    });

    ffmpegProcess.stderr.on('data', (data) => {
        if (isStopping) return;
        const log = data.toString();
        if (log.includes('size=')) {
            if (!ffmpegRecordingStarted) {
                ffmpegRecordingStarted = true;
                event.reply('ffmpeg-recording-start');
            }
            const sizeMatch   = log.match(/size=\s*(\S+)/);
            const timeMatch   = log.match(/time=\s*(\S+)/);
            const bitrateMatch= log.match(/bitrate=\s*(\S+)/);
            const speedMatch  = log.match(/speed=\s*(\S+)/);
            event.reply('recording-stats', {
                size:    sizeMatch    ? sizeMatch[1]    : null,
                time:    timeMatch    ? timeMatch[1]    : null,
                bitrate: bitrateMatch ? bitrateMatch[1] : null,
                speed:   speedMatch   ? speedMatch[1]   : null,
            });
        }
    });

    ffmpegProcess.on('close', (code) => {
        console.log(`[FFmpeg] Process exited with code ${code}`);

        if (isStopping) {
            isStopping = false;
            return;
        }

        mainWindow.webContents.send(
            'status-update',
            '⏹ Recording finished. File saved.'
        );
    });
});

ipcMain.on('stop-mashup', (event) => {
    console.log('[Mashup] Stopping mashup...');

    isStopping = true;

    event.reply('stop-progress', 'stopping-ffmpeg');

    if (ffmpegProcess) {
        ffmpegProcess.kill('SIGKILL');
        ffmpegProcess = null;
    }

    setTimeout(() => {
        event.reply('stop-progress', 'done');
        event.reply('status-update', '⏹ Stopped by user');
        event.reply('video-urls', {});
    }, 400);
});

ipcMain.on('install-update', () => {
    autoUpdater.quitAndInstall();
});

app.on('window-all-closed', () => {
    if (ffmpegProcess) ffmpegProcess.kill();
    app.quit();
});