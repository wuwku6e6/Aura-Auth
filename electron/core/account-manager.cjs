const path = require('path');
const fs = require('fs');
const { Store } = require('./store.cjs');
const { getLogger } = require('./logger.cjs');
const { SteamAccount, MAPPEvents } = require('./steam-account.cjs');

class AccountManager {
	constructor(dataDir) {
		this.dataDir = dataDir;
		this.store = new Store(dataDir);
		this.log = getLogger();
		this.events = new MAPPEvents();
		this.accounts = new Map();

		// Wire MAPPEvents to log
		this.events.on('guard:request', accountName => {
			this.log.info(accountName, 'Требуется код Steam Guard — введите в интерфейсе');
		});
		this.events.on('account:save', ({ name, refreshToken, steamID64, avatar, password, lastLogin, mobileAccessToken, playGames, autoPlay, steamClientRefreshToken }) => {
			this.store.update(name, { refreshToken, steamID64, avatar, password, lastLogin, mobileAccessToken, playGames, autoPlay, steamClientRefreshToken });
		});

		this.massJobs = new Map();
		this.savedRecipients = [];
		this.savedRecipientsPath = path.join(dataDir, 'recipients.json');
		this._loadRecipients();
	}

	// ─── Saved trade recipients (SteamID + token) ─────────────────────────

	_loadRecipients() {
		try {
			if (fs.existsSync(this.savedRecipientsPath)) {
				this.savedRecipients = JSON.parse(fs.readFileSync(this.savedRecipientsPath, 'utf8')) || [];
			}
		} catch (err) {
			this.log.warn('recipients', `Не удалось загрузить получателей: ${err.message}`);
			this.savedRecipients = [];
		}
	}

	_saveRecipients() {
		try {
			fs.mkdirSync(this.dataDir, { recursive: true });
			fs.writeFileSync(this.savedRecipientsPath, JSON.stringify(this.savedRecipients, null, 2), 'utf8');
		} catch (err) {
			this.log.warn('recipients', `Не удалось сохранить получателей: ${err.message}`);
		}
	}

	listRecipients() {
		return this.savedRecipients;
	}

	addRecipient({ label, steamID64, tradeToken }) {
		if (!label || !steamID64) throw new Error('Укажите название и SteamID');
		const entry = { id: Date.now().toString(36), label: String(label).trim(), steamID64: String(steamID64).trim(), tradeToken: (tradeToken || '').trim() };
		this.savedRecipients.push(entry);
		this._saveRecipients();
		this.log.success('recipients', `Получатель «${entry.label}» сохранён`);
		return entry;
	}

	updateRecipient(id, patch) {
		const idx = this.savedRecipients.findIndex(r => r.id === id);
		if (idx === -1) throw new Error('Получатель не найден');
		this.savedRecipients[idx] = Object.assign({}, this.savedRecipients[idx], {
			label: patch.label || this.savedRecipients[idx].label,
			steamID64: patch.steamID64 || this.savedRecipients[idx].steamID64,
			tradeToken: patch.tradeToken !== undefined ? patch.tradeToken : this.savedRecipients[idx].tradeToken
		});
		this._saveRecipients();
		return this.savedRecipients[idx];
	}

	removeRecipient(id) {
		const before = this.savedRecipients.length;
		this.savedRecipients = this.savedRecipients.filter(r => r.id !== id);
		this._saveRecipients();
		return this.savedRecipients.length < before;
	}

	// ─── Account lifecycle ────────────────────────────────────────────────

	init() {
		for (const name of Object.keys(this.store.accounts)) {
			this._attach(name);
		}
		return this.list();
	}

	_attach(name) {
		if (this.accounts.has(name)) return this.accounts.get(name);
		const record = this.store.get(name);
		const account = new SteamAccount(record, this.events);
		this.accounts.set(name, account);
		return account;
	}

	_add(maFileContent) {
		let ma;
		if (typeof maFileContent === 'string') {
			try {
				ma = JSON.parse(maFileContent);
			} catch (e) {
				throw new Error('Не удалось распарсить maFile: ' + e.message);
			}
		} else {
			ma = maFileContent;
		}

		const record = this.store.add(ma);
		const account = this._attach(ma.account_name);

		// Save a copy of the imported maFile into the maFiles folder
		try {
			const safe = (ma.account_name || 'account').replace(/[^\w.-]/g, '_');
			const dest = path.join(this.dataDir, safe + '.maFile');
			const normalized = Object.assign({}, ma, {
				account_name: ma.account_name,
				shared_secret: ma.shared_secret,
				identity_secret: ma.identity_secret,
				device_id: ma.device_id,
				steamid: ma.steamid || record.steamID64 || undefined,
				serial_number: ma.serial_number,
				revocation_code: ma.revocation_code
			});
			fs.writeFileSync(dest, JSON.stringify(normalized, null, 2), 'utf8');
			this.log.success(ma.account_name, `maFile сохранён: maFiles/${safe}.maFile`);
		} catch (err) {
			this.log.warn(ma.account_name, `Не удалось сохранить копию maFile: ${err.message}`);
		}

		this.log.success(ma.account_name, 'Аккаунт добавлен из maFile');
		return account.statusPayload();
	}

	async login(name, password, savePassword) {
		const account = this._attach(name);
		try {
			await account.login({ password, savePassword: !!savePassword });
			return account.statusPayload();
		} catch (err) {
			this.log.error(name, `Вход: ${err.message}`);
			throw err;
		}
	}

	submitGuard(name, code) {
		if (this.events.submitGuardCode(name, code)) {
			this.log.info(name, 'Код Steam Guard получен');
			return true;
		}
		return false;
	}

	cancelGuard(name) {
		if (this.events.cancelGuard(name)) {
			this.log.warn(name, 'Ввод кода Steam Guard отменён');
			return true;
		}
		return false;
	}

	getGuardCode(name) {
		const account = this.accounts.get(name);
		if (!account) throw new Error('Аккаунт не найден');
		return account.getGuardCode();
	}

	async logout(name) {
		const account = this.accounts.get(name);
		if (account) {
			account.stop();
			this.accounts.delete(name);
		}
		return true;
	}

	remove(name) {
		const account = this.accounts.get(name);
		if (account) account.stop();
		this.accounts.delete(name);
		this.store.remove(name);
		this.log.info(name, 'Аккаунт удалён');
		return true;
	}

	async rename(name, newLabel) {
		const account = this.accounts.get(name);
		if (!account) throw new Error('Аккаунт не найден');
		const label = String(newLabel || '').trim();
		if (!label) throw new Error('Название не может быть пустым');
		account.record.label = label;
		this.store.update(name, { label });
		this.events.emit('account:status', account.statusPayload());
		this.log.success(name, `Аккаунт переименован: ${name} → ${label}`);
		return account.statusPayload();
	}

	async setAutoConfirm(name, enabled) {
		const account = this.accounts.get(name);
		if (!account) throw new Error('Аккаунт не найден');
		account.confirmEnabled = !!enabled;
		this.store.update(name, { autoConfirm: !!enabled });
		this.events.emit('account:status', account.statusPayload());
		this.log.info(name, enabled ? 'Автоподтверждение включено' : 'Автоподтверждение выключено');
		return account.statusPayload();
	}

	async setAutoAccept(name, enabled) {
		const account = this.accounts.get(name);
		if (!account) throw new Error('Аккаунт не найден');
		account.acceptEnabled = !!enabled;
		this.store.update(name, { autoAccept: !!enabled });
		this.events.emit('account:status', account.statusPayload());
		this.log.info(name, enabled ? 'Автоприём трейдов включён' : 'Автоприём трейдов выключен');
		return account.statusPayload();
	}

	// ——— «Играть в игры» (как ASF) ———

	async setAutoPlay(name, enabled) {
		const account = this.accounts.get(name);
		if (!account) throw new Error('Аккаунт не найден');
		return account.setAutoPlay(enabled);
	}

	async startPlay(name, appIds) {
		const account = this.accounts.get(name);
		if (!account) throw new Error('Аккаунт не найден');
		return account.startPlay(appIds);
	}

	async stopPlay(name) {
		const account = this.accounts.get(name);
		if (!account) throw new Error('Аккаунт не найден');
		return account.stopPlay();
	}

	// ——— CS2 Trade-Up контракты ———

	async cs2GetInventory(name) {
		const account = this.accounts.get(name);
		if (!account) throw new Error('Аккаунт не найден');
		return account.cs2GetInventory();
	}

	async cs2InventoryWeb(name) {
		const account = this.accounts.get(name);
		if (!account) throw new Error('Аккаунт не найден');
		return account.cs2InventoryWeb();
	}

	async cs2Craft(name, assetIds) {
		const account = this.accounts.get(name);
		if (!account) throw new Error('Аккаунт не найден');
		return account.cs2Craft(assetIds);
	}

	async cs2TradeupOutput(name, inputs) {
		const account = this.accounts.get(name);
		if (!account) throw new Error('Аккаунт не найден');
		return account.cs2TradeupOutput(inputs);
	}

	async cs2ItemIcon(name, skinName) {
		const account = this.accounts.get(name);
		if (!account) throw new Error('Аккаунт не найден');
		return account.cs2ItemIcon(skinName);
	}

	async stopCs2(name) {
		const account = this.accounts.get(name);
		if (!account) throw new Error('Аккаунт не найден');
		return account.stopCs2();
	}

	async cs2GetHistory(name) {
		const account = this.accounts.get(name);
		if (!account) throw new Error('Аккаунт не найден');
		return account.cs2GetHistory();
	}

	// ─── Trades & confirmations (delegated) ──────────────────────────────

	async getOffers(name) {
		const account = this.accounts.get(name);
		if (!account || !account.connected) throw new Error('Аккаунт не подключён');
		await account._refreshOffers();
		return account.offersPayload();
	}

	async getConfirmations(name) {
		const account = this.accounts.get(name);
		if (!account) throw new Error('Аккаунт не найден');
		await account._pollConfirmations();
		return account.confirmationsPayload();
	}

	async acceptOffer(name, offerId) {
		const account = this.accounts.get(name);
		if (!account) throw new Error('Аккаунт не найден');
		return account.acceptOffer(offerId);
	}

	async declineOffer(name, offerId) {
		const account = this.accounts.get(name);
		if (!account) throw new Error('Аккаунт не найден');
		return account.declineOffer(offerId);
	}

	async acceptAllConfirmations(name) {
		const account = this.accounts.get(name);
		if (!account) throw new Error('Аккаунт не найден');
		return account.acceptAllConfirmations();
	}

	async respondConfirmation(name, confId, confKey, accept) {
		const account = this.accounts.get(name);
		if (!account) throw new Error('Аккаунт не найден');
		return account.respondConfirmation(confId, confKey, accept);
	}

	// Находит все активные auth-сессии входа (ожидающие DeviceConfirmation) по всем аккаунтам.
	async listPendingLogins() {
		const all = [];
		for (const account of this.accounts.values()) {
			if (!account.record.mobileAccessToken || !account.record.sharedSecret) continue;
			try {
				const logins = await account.listPendingLogins();
				all.push({ account: account.accountName, logins });
			} catch (e) {
				all.push({ account: account.accountName, logins: [], error: e.message || String(e) });
			}
		}
		return all;
	}

	// Одобрить/отклонить вход одной кнопкой. Пробуем preferred, потом остальные —
	// как это делает мобильное приложение при нескольких аккаунтах.
	async respondLoginRequest(clientId, version, approve, preferredName) {
		const accounts = [];
		if (preferredName && this.accounts.has(preferredName)) accounts.push(this.accounts.get(preferredName));
		for (const account of this.accounts.values()) {
			if (account.accountName !== preferredName) accounts.push(account);
		}
		let lastErr = null;
		for (const account of accounts) {
			if (!account.record.mobileAccessToken || !account.record.sharedSecret) continue;
			try {
				await account.approveLoginByClientId(clientId, version, approve);
				this.log.success(account.accountName, approve ? 'Вход подтверждён' : 'Вход отклонён');
				return { account: account.accountName };
			} catch (e) {
				lastErr = e;
			}
		}
		if (lastErr) throw lastErr;
		throw new Error('Ни один аккаунт не может подтвердить этот вход');
	}

	// ─── Mass sending ─────────────────────────────────────────────────────

	async getInventory(name, appId, contextId) {
		const account = this.accounts.get(name);
		if (!account) throw new Error('Аккаунт не найден');
		return account.getInventory(appId, contextId);
	}

	async startMassSend(name, target, opts) {
		const account = this.accounts.get(name);
		if (!account) throw new Error('Аккаунт не найден');
		if (this.massJobs.has(name)) throw new Error('Массовая отправка уже запущена для этого аккаунта');

		const job = {
			accountName: name,
			status: 'running',
			sent: 0,
			total: 0,
			offers: [],
			error: null
		};
		this.massJobs.set(name, job);
		this.log.info(name, `Запуск массовой отправки → ${target}`);
		this.events.emit('mass:status', job);

		try {
			const result = await account.massSend(target, opts, (sent, total, offers) => {
				job.sent = sent;
				job.total = total;
				job.offers.push(...offers);
				this.events.emit('mass:status', job);
			});
			job.sent = result.sent;
			job.status = 'done';
			this.events.emit('mass:status', job);
			this.log.success(name, 'Массовая отправка завершена');
		} catch (err) {
			job.status = 'error';
			job.error = err.message;
			this.events.emit('mass:status', job);
			this.log.error(name, `Массовая отправка: ${err.message}`);
		} finally {
			this.massJobs.delete(name);
		}
		return job;
	}

	stopMassSend(name) {
		this.massJobs.delete(name);
		return true;
	}

	// ─── Status snapshot ─────────────────────────────────────────────────

	list() {
		return Array.from(this.accounts.values()).map(a => a.statusPayload());
	}

	// ─── Global app settings (language, theme) ──────────────────────────

	getSettings() {
		return this.store.getSettings();
	}

	setSettings(patch) {
		return this.store.setSettings(patch);
	}

	halt() {
		for (const account of this.accounts.values()) {
			account.stop();
		}
	}
}

module.exports = { AccountManager };