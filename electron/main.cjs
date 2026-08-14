const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const dns = require('dns');
const net = require('net');
const https = require('https');
const { AccountManager } = require('./core/account-manager.cjs');
const { getLogger } = require('./core/logger.cjs');

const isDev = !!process.env.VITE_DEV_SERVER_URL;
let mainWindow = null;
let manager = null;

// ─── startup diagnostics ─────────────────────────────────────────
// Crash/error logging is ALWAYS on: writes to aura-auth-startup.log so we can
// diagnose a "window doesn't open" report on a user machine. Milestone logs
// only fire when DEBUG_STARTUP=1 (devtools-style verbose tracing).
const dbg = process.env.DEBUG_STARTUP === '1';
const startupLog = path.join(app.getPath('userData'), 'aura-auth-startup.log');
function crashLog(msg) {
	try { fs.appendFileSync(startupLog, new Date().toISOString() + ' [main] ' + msg + '\r\n'); } catch (e) { /* ignore */ }
}
function dbgLog(msg) { if (dbg) crashLog(msg); }
process.on('uncaughtException', (e) => crashLog('uncaughtException: ' + (e && e.stack ? e.stack : e)));
process.on('unhandledRejection', (e) => crashLog('unhandledRejection: ' + (e && e.stack ? e.stack : e)));
app.on('web-contents-created', (_e, contents) => {
	if (contents.getType() === 'webContents' || contents.getType() === 'backgroundPage') {
		contents.on('render-process-gone', (_c, details) => {
			crashLog('render-process-gone: ' + JSON.stringify(details));
		});
		contents.on('did-fail-load', (_c, errCode, errDesc, url) => {
			crashLog('did-fail-load: code=' + errCode + ' desc=' + errDesc + ' url=' + url);
		});
	}
});

// Провайдерский/системный DNS отдаёт для API Steam «мёртвые» IP (например,
// 139.45.x.x), из-за чего все desktop-клиенты таймаутят, а браузер работает —
// потому что он резолвит через DoH (DNS-over-HTTPS) и получает живые IP.
// Чтобы не зависеть от кривого DNS, подменяем dns.lookup на DoH-резолвер
// (Cloudflare/Google), как в браузере. IP-литералы (сами DNS-серверы) идут
// мимо DoH, чтобы не было рекурсии.
function dohResolve(hostname) {
	const endpoints = [
		`https://1.1.1.1/dns-query?name=${encodeURIComponent(hostname)}&type=A`,
		`https://8.8.8.8/resolve?name=${encodeURIComponent(hostname)}&type=A`
	];
	return new Promise((resolve, reject) => {
		const tryNext = (i) => {
			if (i >= endpoints.length) return reject(new Error('DoH недоступен'));
			const req = https.get(endpoints[i], {
				headers: { 'accept': 'application/dns-json' },
				timeout: 5000
			}, (res) => {
				let body = '';
				res.on('data', (d) => { body += d; });
				res.on('end', () => {
					try {
						const json = JSON.parse(body);
						const ips = (json.Answer || []).filter(a => a.type === 1 || a.type === 'A').map(a => a.data);
						if (ips.length) resolve(ips);
						else tryNext(i + 1);
					} catch (e) { tryNext(i + 1); }
				});
			});
			req.on('error', () => tryNext(i + 1));
			req.on('timeout', () => { req.destroy(); tryNext(i + 1); });
		};
		tryNext(0);
	});
}

function applyPublicDns() {
	const log = getLogger('app');
	const originalLookup = dns.lookup.bind(dns);
	try {
		const patched = function (hostname, options, cb) {
			if (typeof options === 'function') { cb = options; options = {}; }
			// IP-литерал — резолв не нужен (сами DNS-серверы), чтобы не было рекурсии
			if (net.isIP(hostname)) {
				const family = net.isIP(hostname);
				if (options && options.all) return cb(null, [{ address: hostname, family }], family);
				return cb(null, hostname, family);
			}
			dohResolve(hostname).then((ips) => {
				if (!ips.length) return originalLookup(hostname, options, cb);
				// возвращаем ВСЕ адреса массивом → Node сам переберёт их (happy-eyeballs)
				if (options && options.all) return cb(null, ips.map(ip => ({ address: ip, family: 4 })), 4);
				cb(null, ips, 4);
			}).catch(() => originalLookup(hostname, options, cb));
		};
		Object.defineProperty(dns, 'lookup', { value: patched, writable: true, configurable: true });
		if (typeof dns.setDefaultResultOrder === 'function') dns.setDefaultResultOrder('ipv4first');
		log.info('DNS-резолвер переведён на DoH (1.1.1.1 / 8.8.8.8) — обход блокировки «мёртвых» IP Steam');
	} catch (e) {
		log.warn(`Не удалось подменить dns.lookup (${e.message}). Используется системный DNS.`);
	}
}

function createWindow() {
	mainWindow = new BrowserWindow({
		width: 1280,
		height: 840,
		minWidth: 960,
		minHeight: 600,
		backgroundColor: '#0b0e14',
		title: 'Aura Auth',
		autoHideMenuBar: true,
		webPreferences: {
			preload: path.join(__dirname, 'preload.cjs'),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: false
		}
	});

	if (isDev) {
		mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
	} else {
		mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
	}

	mainWindow.webContents.setWindowOpenHandler(({ url }) => {
		shell.openExternal(url);
		return { action: 'deny' };
	});

	// BrowserWindow is hidden until explicitly shown — otherwise the process
	// runs (visible in Task Manager) but the user sees nothing.
	mainWindow.once('ready-to-show', () => mainWindow.show());

	mainWindow.on('closed', () => { mainWindow = null; });
	mainWindow.webContents.on('render-process-gone', (_e, details) => {
		crashLog('render-process-gone (main): ' + JSON.stringify(details));
	});
	mainWindow.webContents.on('did-fail-load', (_e, errCode, errDesc, url) => {
		crashLog('did-fail-load (main): code=' + errCode + ' desc=' + errDesc + ' url=' + url);
	});
}

function broadcast(channel, payload) {
	if (!mainWindow || mainWindow.isDestroyed()) return;
	mainWindow.webContents.send(channel, payload);
}

function broadcastAll(channel, payload) {
	for (const w of BrowserWindow.getAllWindows()) {
		if (!w.isDestroyed()) w.webContents.send(channel, payload);
	}
}

// ─── Login confirmation (mobile-app style, no QR needed) ─────────────
// New-device logins are auth-sessions guarded by DeviceConfirmation, enumerated
// via IAuthenticationService/GetAuthSessionsForAccount. We poll every N seconds
// and broadcast one-tap approval requests.
const LOGIN_POLL_MS = 10000;
const knownLoginRequests = new Map(); // key `${account}::${clientId}` -> timestamp
const respondedLoginRequests = new Map(); // key -> timestamp; suppress re-broadcast after a response
const pendingLoginPoll = { timer: null, running: false };

function pendingLoginKey(account, clientId) {
	return `${account}::${clientId}`;
}

function shouldBroadcastPendingLogin(account, clientId, cooldownMs = 60000) {
	const now = Date.now();
	const key = pendingLoginKey(account, clientId);
	// Don't re-broadcast a request we've just answered (Steam may still list it briefly).
	if (respondedLoginRequests.has(key) && now - respondedLoginRequests.get(key) < 120000) return false;
	const last = knownLoginRequests.get(key);
	if (last !== undefined && now - last < cooldownMs) return false;
	knownLoginRequests.set(key, now);
	return true;
}

async function pollPendingLogins() {
	if (pendingLoginPoll.running || !manager) return;
	pendingLoginPoll.running = true;
	try {
		const groups = await manager.listPendingLogins();
		for (const group of groups) {
			for (const login of group.logins) {
				const key = pendingLoginKey(group.account, login.clientId);
				if (!shouldBroadcastPendingLogin(group.account, login.clientId)) continue;
				broadcast('login:request', {
					account: group.account,
					clientId: login.clientId,
					version: login.version,
					info: login.info,
					ts: knownLoginRequests.get(key)
				});
			}
		}
	} catch (e) {
		// ignore transient network/auth errors
	}
	pendingLoginPoll.running = false;
}

// Manual poll used by the «Подтвердить вход» button.
async function scanPendingLoginsOnce() {
	const groups = await manager.listPendingLogins();
	const found = [];
	const errors = [];
	for (const group of groups) {
		if (group.error) {
			errors.push(`${group.account}: ${group.error}`);
			continue;
		}
		for (const login of group.logins) {
			found.push({
				account: group.account,
				clientId: login.clientId,
				version: login.version,
				info: login.info
			});
		}
	}
	if (found.length === 0 && errors.length > 0) {
		throw new Error(errors.join('; '));
	}
	return found;
}

function startLoginPoller() {
	if (pendingLoginPoll.timer) clearInterval(pendingLoginPoll.timer);
	pendingLoginPoll.timer = setInterval(pollPendingLogins, LOGIN_POLL_MS);
	pollPendingLogins(); // immediate first poll
}

let inventoryWindow = null;
let lastInventorySelection = [];

let cs2Window = null;

let offerWindow = null;
let settingsWindow = null;
const pendingOffers = new Map();

function openOfferWindow(name, offer) {
	const offerId = offer && offer.id;
	if (offer && offerId) pendingOffers.set(String(offerId), { name, offer });

	const hash = `#name=${encodeURIComponent(name)}&offer=${encodeURIComponent(offerId || '')}`;
	const loadHash = () => {
		if (isDev) {
			offerWindow.loadURL(`${process.env.VITE_DEV_SERVER_URL}/offers.html${hash}`);
		} else {
			offerWindow.loadFile(path.join(__dirname, '../dist/offers.html'), { hash });
		}
	};

	if (offerWindow && !offerWindow.isDestroyed()) {
		loadHash();
		offerWindow.focus();
		return;
	}
	offerWindow = new BrowserWindow({
		width: 760,
		height: 680,
		minWidth: 480,
		minHeight: 420,
		backgroundColor: '#0b0e14',
		title: `Предложение обмена — ${name}`,
		parent: mainWindow,
		autoHideMenuBar: true,
		webPreferences: {
			preload: path.join(__dirname, 'preload.cjs'),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: false
		}
	});
	offerWindow.on('closed', () => { offerWindow = null; });
	offerWindow.once('ready-to-show', () => offerWindow.show());
	loadHash();
}

function openSettingsWindow() {
	if (settingsWindow && !settingsWindow.isDestroyed()) {
		settingsWindow.focus();
		return;
	}
	settingsWindow = new BrowserWindow({
		width: 640,
		height: 560,
		minWidth: 480,
		minHeight: 420,
		backgroundColor: '#0b0e14',
		title: 'Настройки — Aura Auth',
		parent: mainWindow,
		autoHideMenuBar: true,
		webPreferences: {
			preload: path.join(__dirname, 'preload.cjs'),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: false
		}
	});
	settingsWindow.on('closed', () => { settingsWindow = null; });
	settingsWindow.once('ready-to-show', () => settingsWindow.show());
	if (isDev) {
		settingsWindow.loadURL(`${process.env.VITE_DEV_SERVER_URL}/settings.html`);
	} else {
		settingsWindow.loadFile(path.join(__dirname, '../dist/settings.html'));
	}
}

function openCs2Window(name) {
	if (cs2Window && !cs2Window.isDestroyed()) {
		cs2Window.focus();
		return;
	}
	cs2Window = new BrowserWindow({
		width: 1080,
		height: 760,
		minWidth: 680,
		minHeight: 520,
		backgroundColor: '#0b0e14',
		title: `Контракты CS2 — ${name}`,
		parent: mainWindow,
		autoHideMenuBar: true,
		webPreferences: {
			preload: path.join(__dirname, 'preload.cjs'),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: false
		}
	});
	cs2Window.on('closed', () => {
		cs2Window = null;
		manager.stopCs2(name).catch(() => {});
	});
	cs2Window.once('ready-to-show', () => cs2Window.show());

	const hash = `#name=${encodeURIComponent(name)}`;
	if (isDev) {
		cs2Window.loadURL(`${process.env.VITE_DEV_SERVER_URL}/cs2.html${hash}`);
	} else {
		cs2Window.loadFile(path.join(__dirname, '../dist/cs2.html'), { hash });
	}
}

function openInventoryWindow(name, appId, contextId) {
	if (inventoryWindow && !inventoryWindow.isDestroyed()) {
		inventoryWindow.focus();
		return;
	}
	inventoryWindow = new BrowserWindow({
		width: 980,
		height: 700,
		minWidth: 560,
		minHeight: 420,
		backgroundColor: '#0b0e14',
		title: `Инвентарь — ${name}`,
		parent: mainWindow,
		autoHideMenuBar: true,
		webPreferences: {
			preload: path.join(__dirname, 'preload.cjs'),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: false
		}
	});
	inventoryWindow.on('closed', () => { inventoryWindow = null; });
	inventoryWindow.once('ready-to-show', () => inventoryWindow.show());

	const hash = `#name=${encodeURIComponent(name)}&app=${appId}&ctx=${contextId}`;
	if (isDev) {
		inventoryWindow.loadURL(`${process.env.VITE_DEV_SERVER_URL}/inventory.html${hash}`);
	} else {
		inventoryWindow.loadFile(path.join(__dirname, '../dist/inventory.html'), { hash });
	}
}

function setupIPC() {
	const log = getLogger();

	// Push events from account manager to renderer
	manager.events.on('guard:request', (name) => {
		broadcast('guard:request', { account: name });
	});
	manager.events.on('account:status', (payload) => {
		broadcast('account:status', payload);
	});
	manager.events.on('account:offers', (payload) => {
		broadcast('account:offers', payload);
	});
	manager.events.on('account:confirmations', (payload) => {
		broadcast('account:confirmations', payload);
	});
	manager.events.on('mass:status', (payload) => {
		broadcast('mass:status', payload);
	});
	log.subscribe(entries => {
		broadcast('log:update', entries);
	});

	const wrap = async (event, fn) => {
		try {
			return { ok: true, data: await fn() };
		} catch (err) {
			return { ok: false, error: err.message || String(err) };
		}
	};

	ipcMain.handle('app:init', (event) => wrap(event, async () => {
		return { accounts: manager.list(), logs: log.entries };
	}));

	ipcMain.handle('account:addMafile', (event, content) => wrap(event, async () => {
		return manager._add(content);
	}));

	ipcMain.handle('account:login', (event, { name, password, savePassword }) => wrap(event, async () => {
		return manager.login(name, password, savePassword);
	}));

	ipcMain.handle('account:submitGuard', (event, { name, code }) => wrap(event, async () => {
		if (code === '__cancel__') return manager.cancelGuard(name);
		return manager.submitGuard(name, code);
	}));

	ipcMain.handle('account:guardCode', (event, name) => wrap(event, async () => manager.getGuardCode(name)));

	ipcMain.handle('account:logout', (event, name) => wrap(event, async () => {
		return manager.logout(name);
	}));

	ipcMain.handle('account:rename', (event, { name, label }) => wrap(event, async () => {
		return manager.rename(name, label);
	}));

	ipcMain.handle('account:remove', (event, name) => wrap(event, async () => {
		return manager.remove(name);
	}));

	ipcMain.handle('account:autoConfirm', (event, { name, enabled }) => wrap(event, async () => {
		return manager.setAutoConfirm(name, enabled);
	}));

	ipcMain.handle('account:autoAccept', (event, { name, enabled }) => wrap(event, async () => {
		return manager.setAutoAccept(name, enabled);
	}));

	ipcMain.handle('account:autoPlay', (event, { name, enabled }) => wrap(event, async () => {
		return manager.setAutoPlay(name, enabled);
	}));

	ipcMain.handle('account:play', (event, { name, appIds }) => wrap(event, async () => {
		return manager.startPlay(name, appIds);
	}));

	ipcMain.handle('account:stopPlay', (event, name) => wrap(event, async () => {
		return manager.stopPlay(name);
	}));

	ipcMain.handle('account:list', (event) => wrap(event, async () => manager.list()));

	ipcMain.handle('trades:offers', (event, name) => wrap(event, async () => manager.getOffers(name)));
	ipcMain.handle('trades:accept', (event, { name, offerId }) => wrap(event, async () => manager.acceptOffer(name, offerId)));
	ipcMain.handle('trades:decline', (event, { name, offerId }) => wrap(event, async () => manager.declineOffer(name, offerId)));
	ipcMain.handle('offer:open', (event, { name, offer }) => {
		openOfferWindow(name, offer);
		return { ok: true };
	});
	ipcMain.handle('offer:get', (event, offerId) => {
		const p = pendingOffers.get(String(offerId));
		return p ? p.offer : null;
	});
	ipcMain.handle('settings:open', (event) => {
		openSettingsWindow();
		return { ok: true };
	});
	ipcMain.handle('settings:get', (event) => manager.getSettings());
	ipcMain.handle('settings:set', (event, patch) => {
		const s = manager.setSettings(patch || {});
		broadcastAll('settings:changed', s);
		return s;
	});

	// --- App info / auto-update ---
	// Manual flow (triggered from Settings → "Проверить обновления"):
	//   checkForUpdates  -> {available, version}
	//   downloadUpdate   -> downloads + fires update-downloaded
	//   installUpdate    -> quitAndInstall
	ipcMain.handle('app:checkForUpdates', async () => {
		if (!app.isPackaged) return { available: false, current: app.getVersion() };
		try {
			const result = await autoUpdater.checkForUpdates();
			const current = app.getVersion();
			const version = result?.updateInfo?.version;
			return {
				current,
				version,
				available: !!version && version !== current
			};
		} catch (e) {
			return { available: false, current: app.getVersion(), error: e.message };
		}
	});
	ipcMain.handle('app:downloadUpdate', async () => {
		if (!app.isPackaged) return { ok: false };
		await autoUpdater.downloadUpdate();
		return { ok: true };
	});
	ipcMain.handle('app:installUpdate', async () => {
		await autoUpdater.quitAndInstall();
	});
	ipcMain.handle('app:getVersion', () => app.getVersion());
	ipcMain.handle('app:openExternalLink', (event, url) => shell.openExternal(url));

	ipcMain.handle('confirms:list', (event, name) => wrap(event, async () => manager.getConfirmations(name)));
	ipcMain.handle('confirms:acceptAll', (event, name) => wrap(event, async () => manager.acceptAllConfirmations(name)));
	ipcMain.handle('confirms:respond', (event, { name, confId, confKey, accept }) => wrap(event, async () => manager.respondConfirmation(name, confId, confKey, accept)));

	// Подтверждение входа на новом устройстве (device-confirmation через GetAuthSessionsForAccount)
	ipcMain.handle('login:list', (event) => wrap(event, async () => scanPendingLoginsOnce()));
	ipcMain.handle('login:respond', (event, { name, clientId, version, approve }) => wrap(event, async () => {
		try {
			const r = await manager.respondLoginRequest(clientId, version, approve, name);
			respondedLoginRequests.set(pendingLoginKey(name, clientId), Date.now());
			return r;
		} catch (e) {
			// Already-handled requests (e.g. WebAPI error 29) should not be re-broadcast either.
			if (/29|уже|already|confirmed|подтвержд/i.test(e.message || '')) {
				respondedLoginRequests.set(pendingLoginKey(name, clientId), Date.now());
			}
			throw e;
		}
	}));

	ipcMain.handle('inventory:get', (event, { name, appId, contextId }) => wrap(event, async () => manager.getInventory(name, appId, contextId)));

	ipcMain.handle('cs2:inventory', (event, name) => wrap(event, async () => manager.cs2GetInventory(name)));
	ipcMain.handle('cs2:inventory-web', (event, name) => wrap(event, async () => manager.cs2InventoryWeb(name)));
	ipcMain.handle('cs2:craft', (event, { name, assetIds }) => wrap(event, async () => manager.cs2Craft(name, assetIds)));
	ipcMain.handle('cs2:icon', (event, { name, skin }) => wrap(event, async () => manager.cs2ItemIcon(name, skin)));
	ipcMain.handle('cs2:tradeup', (event, { name, inputs }) => wrap(event, async () => manager.cs2TradeupOutput(name, inputs)));
	ipcMain.handle('cs2:history', (event, name) => wrap(event, async () => manager.cs2GetHistory(name)));

	ipcMain.handle('cs2:open', (event, name) => {
		openCs2Window(name);
		return { ok: true };
	});

	ipcMain.handle('inventory:open', (event, { name, appId, contextId }) => {
		openInventoryWindow(name, appId, contextId);
		return { ok: true };
	});

	ipcMain.handle('inventory:select', (event, assetIds) => {
		lastInventorySelection = Array.isArray(assetIds) ? assetIds : [];
		if (mainWindow && !mainWindow.isDestroyed()) {
			mainWindow.webContents.send('inventory:selected', lastInventorySelection);
		}
		return { ok: true };
	});

	ipcMain.handle('mass:start', (event, { name, target, opts }) => wrap(event, async () => manager.startMassSend(name, target, opts)));
	ipcMain.handle('mass:stop', (event, name) => wrap(event, async () => manager.stopMassSend(name)));

	ipcMain.handle('recipients:list', (event) => wrap(event, async () => manager.listRecipients()));
	ipcMain.handle('recipients:add', (event, data) => wrap(event, async () => manager.addRecipient(data)));
	ipcMain.handle('recipients:update', (event, { id, patch }) => wrap(event, async () => manager.updateRecipient(id, patch)));
	ipcMain.handle('recipients:remove', (event, id) => wrap(event, async () => manager.removeRecipient(id)));

	ipcMain.handle('dialog:openMafile', async () => {
		const result = await dialog.showOpenDialog(mainWindow, {
			title: 'Выберите maFile (.maFile / .json)',
			filters: [
				{ name: 'Steam maFile', extensions: ['maFile', 'json', 'txt'] },
				{ name: 'Все файлы', extensions: ['*'] }
			],
			properties: ['openFile', 'multiSelections']
		});
		if (result.canceled || !result.filePaths.length) return { ok: true, data: [] };
		const contents = [];
		for (const file of result.filePaths) {
			try {
				contents.push({ file, content: fs.readFileSync(file, 'utf8') });
			} catch (err) {
				log.error('maFile', `Не удалось прочитать ${file}: ${err.message}`);
			}
		}
		return { ok: true, data: contents };
	});
}

function setupAutoUpdater() {
	if (!app.isPackaged) return; // only update the installed (packaged) build
	const log = getLogger('updater');
	autoUpdater.autoDownload = false; // we prompt the user in the UI instead
	autoUpdater.autoInstallOnAppQuit = false;

	// Inform any open window of update progress (manual check initiated from Settings).
	autoUpdater.on('update-available', (info) => {
		log.info(`Доступно обновление ${info.version}`);
		broadcastAll('app:updateAvailable', { available: true, version: info.version, info });
	});
	autoUpdater.on('update-not-available', () => {
		broadcastAll('app:updateAvailable', { available: false });
	});
	autoUpdater.on('download-progress', (p) => {
		broadcastAll('app:updateProgress', p);
	});
	autoUpdater.on('update-downloaded', (info) => {
		log.info(`Обновление ${info.version} загружено`);
		broadcastAll('app:updateAvailable', { available: true, version: info.version, downloaded: true, info });
	});
	autoUpdater.on('error', (err) => {
		log.warn(`Ошибка авто-обновления: ${err.message}`);
		broadcastAll('app:updateAvailable', { available: false, error: err.message });
	});
	// Manual check only — no background polling on startup.
}

// Disable GPU acceleration: on secondary PCs / VMs / RDP the GPU process can
// blank the window (process alive, no visible window).
app.disableHardwareAcceleration();

	app.whenReady().then(() => {
		dbgLog('ready');
		applyPublicDns();
		dbgLog('dns applied');
		// Account data (maFiles, accounts.json, settings.json) lives next to the
		// executable in packaged mode, or at the project root in dev mode — same as
		// the classic Steam Desktop Authenticator. Users simply drop their `maFiles`
		// folder (with *.maFile + accounts.json) into the app directory.
		// process.resourcesPath = <installDir>/resources in a packaged app, so
		// path.join(process.resourcesPath, '..') == <installDir> (app root).
		let dataDir;
	try {
		dataDir = app.isPackaged
			? path.join(process.resourcesPath, '..', 'maFiles')
			: path.join(__dirname, '..', 'maFiles');
	} catch (e) {
		getLogger('app').warn('compute dataDir fallback: ' + e.message);
		dataDir = path.join(app.getPath('userData'), 'maFiles');
	}
		fs.mkdirSync(dataDir, { recursive: true });
	manager = new AccountManager(dataDir);
	manager.init();
	dbgLog('manager init done, dataDir=' + dataDir);
	setupIPC();
	setupAutoUpdater();
	createWindow();
	dbgLog('window created');
	startLoginPoller();
	dbgLog('startup complete');

	// Attempt auto-login for accounts that have refresh tokens
	setTimeout(() => {
		for (const account of manager.accounts.values()) {
			if (account.record.refreshToken) {
				account.relogin().then(ok => {
					if (ok) {
						broadcast('account:status', account.statusPayload());
					}
				}).catch(() => {});
			}
		}
	}, 2500);

	app.on('activate', () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow();
	});
});

app.on('window-all-closed', () => {
	manager && manager.halt();
	if (process.platform !== 'darwin') app.quit();
});