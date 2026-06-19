// main.js
import { app, BrowserWindow, ipcMain } from 'electron';
import { spawn } from 'child_process';
import { execa } from 'execa';
import { readFileSync } from 'fs';
import { join } from 'path';

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
        minWidth: 1000,
        minHeight: 600,
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

    // mainWindow.webContents.openDevTools();
    
    mainWindow.webContents.on('did-finish-load', () => {
        mainWindow.webContents.send('load-config', config);
    });
}

app.whenReady().then(createWindow);

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
    // Kill any previous ffmpeg before starting fresh
    if (ffmpegProcess) {
        isStopping = true;
        ffmpegProcess.kill('SIGKILL');
        ffmpegProcess = null;
    }
    isStopping = false;

    console.log(`[Mashup] Starting mashup for ${streamers.join(', ')}...`);
    event.reply('status-update', '🔍 Checking streams via Streamlink...');
    
    const urls = await Promise.all(streamers.map(getAudioUrl));

    // Bail out early if stopped while we were fetching
    if (isStopping) return;

    const activeUrls = urls.filter(url => url !== null);

    console.log(`[Mashup] Got ${activeUrls.length} active streams out of ${streamers.length}`);

    if (activeUrls.length < 2) {
        console.error('[Mashup] At least 2 active streams required!');
        event.reply('status-update', '❌ Error: At least 2 active streams required!');
        return;
    }

    if (activeUrls.length > 0) {
        const videoUrls = {};
        for (const streamer of streamers) {
            if (isStopping) return;
            videoUrls[streamer] = await getVideoUrl(streamer);
        }
        if (isStopping) return;
        event.reply('video-urls', videoUrls);
    }

    if (isStopping) return;

    console.log(`[Mashup] Starting audio mix for ${activeUrls.length} streams...`);
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
            event.reply('status-update', '🔴 Recording: ' + log.trim().substring(0, 40) + '...');
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

    if (ffmpegProcess) {
        ffmpegProcess.kill('SIGKILL');
        ffmpegProcess = null;
    }

    event.reply('status-update', '⏹ Stopped by user');
});

app.on('window-all-closed', () => {
    if (ffmpegProcess) ffmpegProcess.kill();
    app.quit();
});