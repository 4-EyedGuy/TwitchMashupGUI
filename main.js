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
    console.log('Config не найден, используем пустые значения');
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
    isStopping = false;
    console.log(`[Mashup] 🎬 Запуск мэшапа для ${streamers.join(', ')}...`);
    event.reply('status-update', '🔍 Проверка стримов через Streamlink...');
    
    const urls = await Promise.all(streamers.map(getAudioUrl));
    const activeUrls = urls.filter(url => url !== null);

    console.log(`[Mashup] Получено ${activeUrls.length} активных стримов из ${streamers.length}`);

    if (activeUrls.length < 2) {
        console.error('[Mashup] ❌ Нужно минимум 2 активных стрима!');
        event.reply('status-update', '❌ Ошибка: Нужно минимум 2 активных стрима в эфире!');
        return;
    }


    if (activeUrls.length > 0) {
        const videoUrls = {};
        for (const streamer of streamers) {
            videoUrls[streamer] =
                await getVideoUrl(streamer);
        }
        event.reply('video-urls', videoUrls);
    }

    console.log(`[Mashup] 🎙 Запуск микширования ${activeUrls.length} стримов...`);
    event.reply('status-update', '🎙 Найдено стримов: ' + activeUrls.length + '. Запуск микширования...');

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

    console.log('[FFmpeg] ▶️ Запущен процесс ffmpeg');

    ffmpegProcess.on('error', (error) => {
        console.error('[FFmpeg] ❌ Ошибка запуска:', error.message);
        if (error.code === 'ENOENT') {
            console.error('[FFmpeg] ⚠️ FFmpeg не найден! Установи: choco install ffmpeg');
            event.reply('status-update', '❌ FFmpeg не найден. Установи командой: choco install ffmpeg');
        }
    });

    ffmpegProcess.stderr.on('data', (data) => {
        const log = data.toString();
        if (log.includes('size=')) {
            event.reply('status-update', '🔴 Идет запись: ' + log.trim().substring(0, 40) + '...');
        }
    });

    ffmpegProcess.on('close', (code) => {
        console.log(`[FFmpeg] ⏹ Процесс завершен с кодом ${code}`);

        if (isStopping) {
            isStopping = false;
            return;
        }

        mainWindow.webContents.send(
            'status-update',
            '⏹ Запись завершена. Файл сохранен.'
        );
    });
});

ipcMain.on('stop-mashup', (event) => {
    console.log('[Mashup] ⏹ Остановка мэшапа...');

    isStopping = true;

    if (ffmpegProcess) {
        ffmpegProcess.kill('SIGKILL');
        ffmpegProcess = null;
    }

    event.reply('status-update', '⏹ Остановлено пользователем');
});

app.on('window-all-closed', () => {
    if (ffmpegProcess) ffmpegProcess.kill();
    app.quit();
});
