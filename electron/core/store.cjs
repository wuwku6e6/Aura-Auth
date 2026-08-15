const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class Store {
	constructor(dataDir) {
		this.dataDir = dataDir;
		this.accountsPath = path.join(dataDir, 'accounts.json');
		this.settingsPath = path.join(dataDir, 'settings.json');
		this.accounts = {};
		this.settings = { language: 'ru', theme: 'aura' };
		this._load();
		this._loadSettings();
	}

	_load() {
		try {
			if (fs.existsSync(this.accountsPath)) {
				this.accounts = JSON.parse(fs.readFileSync(this.accountsPath, 'utf8'));
			}
		} catch (err) {
			console.error('Failed to load accounts:', err);
			this.accounts = {};
		}
	}

	_save() {
		fs.mkdirSync(this.dataDir, { recursive: true });
		fs.writeFileSync(this.accountsPath, JSON.stringify(this.accounts, null, 2), 'utf8');
	}

		list() {
		return Object.values(this.accounts).map(a => ({
			name: a.accountName,
			label: a.label || a.accountName,
			steamID64: a.steamID64 || null,
			avatar: this._normalizeAvatar(a.avatar),
			has2FA: !!a.sharedSecret,
			hasIdentity: !!a.identitySecret,
			autoConfirm: !!a.autoConfirm,
			autoAccept: !!a.autoAccept,
			autoSendTarget: a.autoSendTarget || null,
			proxy: a.proxy || null,
			lastLogin: a.lastLogin || null,
			online: !!a.online
		}));
	}

	add(maData) {
		const accountName = maData.account_name;
		if (!accountName) throw new Error('maFile не содержит account_name');
		const existing = this.accounts[accountName] || {};
		this.accounts[accountName] = Object.assign({}, existing, {
			accountName,
			sharedSecret: maData.shared_secret || existing.sharedSecret,
			identitySecret: maData.identity_secret || existing.identitySecret,
			deviceID: maData.device_id || existing.deviceID || null,
			serial: maData.serial_number || existing.serial,
			revocation: maData.revocation_code || existing.revocation,
			steamID64: maData.steamid || existing.steamID64 || null,
			proxy: maData.proxy || existing.proxy || null,
			addedAt: existing.addedAt || Date.now()
		});
		this._save();
		return this.get(accountName);
	}

	get(name) {
		return this.accounts[name] || null;
	}

	update(name, patch) {
		if (!this.accounts[name]) return null;
		Object.assign(this.accounts[name], patch);
		this._save();
		return this.accounts[name];
	}

	remove(name) {
		let record = this.accounts[name];
		if (!record) return false;
		delete this.accounts[name];
		this._save();
		return true;
	}

	// ─── Global app settings (language, theme) ──────────────────────────

	_loadSettings() {
		try {
			if (fs.existsSync(this.settingsPath)) {
				const s = JSON.parse(fs.readFileSync(this.settingsPath, 'utf8'));
				this.settings = Object.assign({ language: 'ru', theme: 'aura' }, s);
			}
		} catch (err) {
			console.error('Failed to load settings:', err);
		}
	}

	_saveSettings() {
		try {
			fs.mkdirSync(this.dataDir, { recursive: true });
			fs.writeFileSync(this.settingsPath, JSON.stringify(this.settings, null, 2), 'utf8');
		} catch (err) {
			console.error('Failed to save settings:', err);
		}
	}

	getSettings() {
		return { ...this.settings };
	}

	setSettings(patch) {
		this.settings = Object.assign({}, this.settings, patch);
		this._saveSettings();
		return { ...this.settings };
	}

	// Аватары сохранялись как http://steamcdn-a.akamaihd.net/... — рендерер их блокирует.
	// Нормализуем к https://avatars.steamstatic.com (тот же контент).
	_normalizeAvatar(url) {
		if (!url || typeof url !== 'string') return null;
		const m = url.match(/([0-9a-f]{40})_full\.jpg/i);
		if (m) return `https://avatars.steamstatic.com/${m[1]}_full.jpg`;
		return url.replace(/^http:\/\//i, 'https://');
	}
}

module.exports = { Store };