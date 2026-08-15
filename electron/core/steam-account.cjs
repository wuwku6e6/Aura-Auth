const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { EventEmitter } = require('events');
const { normalizeProxy } = require('./proxy.cjs');
const { LoginSession, LoginApprover, EAuthTokenPlatformType, EAuthSessionGuardType, ESessionPersistence } = require('steam-session');
const SteamTotp = require('steam-totp');
const SteamCommunity = require('steamcommunity');
const TradeOfferManager = require('steam-tradeoffer-manager');
const SteamUser = require('steam-user');
const GlobalOffensive = require('globaloffensive');
const { getLogger } = require('./logger.cjs');
const steamAuthWebapi = require('./steam-auth-webapi.cjs');

const APP_DATA = path.join(os.homedir(), 'AppData', 'Roaming', 'AuraAuth');


class MAPPEvents extends EventEmitter {
	constructor() {
		super();
		this.pendingGuard = new Map(); // accountName -> { resolve, reject }
	}

	// Returns a promise that resolves to the code entered by the user
	requestGuardCode(accountName) {
		return new Promise((resolve, reject) => {
			this.pendingGuard.set(accountName, { resolve, reject });
			this.emit('guard:request', accountName);
			// Timeout after 2 minutes
			setTimeout(() => {
				if (this.pendingGuard.has(accountName)) {
					const entry = this.pendingGuard.get(accountName);
					this.pendingGuard.delete(accountName);
					entry.reject(new Error('Таймаут ожидания кода Steam Guard'));
				}
			}, 120000);
		});
	}

	submitGuardCode(accountName, code) {
		const entry = this.pendingGuard.get(accountName);
		if (!entry) return false;
		this.pendingGuard.delete(accountName);
		entry.resolve(code);
		return true;
	}

	cancelGuard(accountName) {
		const entry = this.pendingGuard.get(accountName);
		if (!entry) return false;
		this.pendingGuard.delete(accountName);
		entry.reject(new Error('Запрос кода отменён'));
		return true;
	}
}

class SteamAccount {
	static _cs2HashCache = new Map();

	constructor(record, events) {
		this.record = record;
		this.accountName = record.accountName;
		this.events = events;
		this.log = getLogger();

		this.session = null;
		this.community = null;
		this.manager = null;
		this.cookies = null;
		this.accessToken = null;
		this.steamID = null;

		this.confirmTimer = null;
		this.offersTimer = null;
		this._confirmBackoff = null;
		this.confirmEnabled = !!record.autoConfirm;
		this.acceptEnabled = !!record.autoAccept;
		// Прокси для всех Steam‑соединений аккаунта (socks5://, socks4://, http://, https://).
		// Применяется к LoginSession, SteamUser (play‑client) и SteamCommunity.
		this.proxy = (record.proxy || '').trim();
		this.polling = false;
		this.connected = false;

		// «Играть в игры» (как ASF: SteamKit/CM клиент, отчёт games-played без запуска игры).
		// Для CM-логина нужен refresh-токен с aud=client (SteamClient), а у нас сохранён
		// MobileApp токен (aud=mobile). Поэтому первый игровой клиент логиним по паролю+2FA,
		// а полученный SteamClient refresh-токен переиспользуем при перезапусках.
		this.playClient = null;
		this.playAppIds = Array.isArray(record.playGames) ? record.playGames.map(Number).filter(n => n > 0) : [];
		this.autoPlayEnabled = !!record.autoPlay;
		this.playStatus = { state: 'stopped', games: [], label: 'Не играет' };
		this._playRetryTimer = null;

		// CS2 Trade-Up контракты (глобальный координатор CS:GO через play-клиент).
		this.cs2 = null;               // GlobalOffensive
		this.cs2Cell = null;           // promise ожидания connectedToGC
		this.cs2ErrorTimer = null;
		this.cs2State = { state: 'idle', label: 'Не подключён' };

		this.confirmations = [];
		this.sentOffers = [];
		this.receivedOffers = [];

		this._guardCallbacks = new Set();
		this._statusTimers = {};
		this._lastConfTs = {};
		this._offersRefreshing = false;
		this._offersRefreshTimer = null;
	}

	// ─── Proxy helpers ───────────────────────────────────────────────────

	// steamuser + steam-session принимают строковый SOCKS/HTTP(S)‑прокси.
	// Возвращаем одну опцию (они взаимно эксклюзивны): socksProxy | httpProxy.
	_proxySteamOpts() {
		const p = normalizeProxy(this.proxy);
		if (!p) return {};
		if (p.startsWith('socks')) return { socksProxy: p };
		return { httpProxy: p };
	}

	// steamcommunity построен на `request`; чтобы проксировать его, передаём
	// заранее настроенный экземпляр request (proxy=HTTP CONNECT / agent=SOCKS).
	_proxyCommunityOpts() {
		const p = normalizeProxy(this.proxy);
		if (!p) return {};
		try {
			const Request = require('request');
			if (p.startsWith('socks')) {
				const SocksProxyAgent = require('socks-proxy-agent').SocksProxyAgent;
				return { request: Request.defaults({ agent: new SocksProxyAgent(p) }) };
			}
			return { request: Request.defaults({ proxy: p }) };
		} catch (e) {
			this.log.warn(this.accountName, `Не удалось инициализировать прокси для SteamCommunity (${e.message})`);
			return {};
		}
	}

	// ─── Lifecycle ────────────────────────────────────────────────────────

	async login({ password, guardCode, savePassword = false } = {}) {
		this.setStatus('connecting', 'Запуск авторизации');
		if (password && savePassword) {
			this.record.password = password; // remember for auto-relogin
		}

		const needsPassword = !password;
		if (needsPassword && this.record.refreshToken) {
			// Try a token-only login first
			try {
				return await this._loginWithRefreshToken();
			} catch (err) {
				this.log.warn(this.accountName, `Refresh-токен не сработал: ${err.message}`);
				this.setStatus('connecting', 'Токен недействителен — нужен пароль');
			}
		}

		if (!needsPassword) {
			return this._loginWithCredentials(password, guardCode);
		}

		// Fallback: use a stored password for auto-login
		if (this.record.password) {
			return this._loginWithCredentials(this.record.password, guardCode);
		}

		throw new Error('Требуется пароль для входа');
	}

	// Сетевая ли это ошибка (нет связи со Steam), а не проблема с учётными данными.
	// Такие сбои не стоит выдавать за «недействительный токен/пароль».
	static _isNetworkError(err) {
		if (!err) return false;
		const codes = new Set([
			'ETIMEDOUT', 'ENOTFOUND', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN',
			'ENETUNREACH', 'EHOSTUNREACH', 'ECONNABORTED', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT'
		]);
		if (err.code && codes.has(err.code)) return true;
		// AggregateError при нескольких неудачных попытках соединения (Node net)
		if (Array.isArray(err.errors)) {
			return err.errors.some(e => e && (codes.has(e.code) || SteamAccount._isNetworkError(e)));
		}
		const msg = String(err.message || '');
		return /ETIMEDOUT|ENOTFOUND|ECONNREFUSED|ECONNRESET|getaddrinfo|network is unreachable|socket hung up|connect .* timeout/i.test(msg);
	}

	async relogin() {
		const inspect = (e) => {
			const u = require('util');
			try { return u.inspect(e, { depth: 4 }); } catch (_) { return String(e); }
		};
		// 1) Refresh-token first
		if (this.record.refreshToken) {
			try {
				await this._loginWithRefreshToken();
				return true;
			} catch (err) {
				if (SteamAccount._isNetworkError(err)) {
					// Сеть недоступна — пароль тоже не пройдёт, не тратим ещё 20с на попытку.
					this.log.error(this.accountName, `Сетевая ошибка входа: нет связи со Steam (${err.code || 'network'})`);
					this.log.debug(this.accountName, inspect(err));
					this._lastLoginNetworkError = true;
					return false;
				}
				this.log.warn(this.accountName, `Refresh-токен недействителен: ${err && err.message}`);
				this.log.debug(this.accountName, inspect(err));
			}
		}

		// 2) Fallback: stored password + 2FA code from shared_secret
		if (this.record.password) {
			try {
				await this._loginWithCredentials(this.record.password);
				this.log.success(this.accountName, 'Автовход по паролю');
				return true;
			} catch (err) {
				if (SteamAccount._isNetworkError(err)) {
					this.log.error(this.accountName, `Сетевая ошибка входа по паролю: нет связи со Steam (${err.code || 'network'})`);
					this.log.debug(this.accountName, inspect(err));
					return false;
				}
				this.log.warn(this.accountName, `Автовход по паролю не удался: ${err && err.message}`);
				this.log.debug(this.accountName, inspect(err));
			}
		}
		return false;
	}

	async _loginWithRefreshToken() {
		this.log.info(this.accountName, 'Вход через сохранённый refresh-токен');
		const session = new LoginSession(EAuthTokenPlatformType.MobileApp, this._proxySteamOpts());
		session.refreshToken = this.record.refreshToken;
		const cookies = await session.getWebCookies();
		this.session = session;
		this.steamID = session.steamID.toString();
		this.record.steamID64 = this.steamID;
		if (session.refreshToken && session.refreshToken !== this.record.refreshToken) {
			this.record.refreshToken = session.refreshToken;
		}
		this.record.lastLogin = Date.now();
		this._save();
		this._setupCommunity(cookies);
		this._resumeAutoPlay();
		return true;
	}

	async _loginWithCredentials(password, guardCode) {
		const session = new LoginSession(EAuthTokenPlatformType.MobileApp, this._proxySteamOpts());
		this._guardCallbacks.clear();

		// We pre-generate the 2FA code from shared_secret when available.
		let code = guardCode;
		if (!code && this.record.sharedSecret) {
			code = SteamTotp.generateAuthCode(this.record.sharedSecret);
		}

		await this._awaitAuthentication(session, password, async (needCode) => {
			if (needCode) {
				if (this.record.sharedSecret) {
					// supply a fresh code from our authenticator
					await session.submitSteamGuardCode(SteamTotp.generateAuthCode(this.record.sharedSecret));
					return true;
				}
				// The caller can provide a code via guardCode
				if (guardCode) {
					await session.submitSteamGuardCode(guardCode);
					return true;
				}
				// Surface a request to the UI for a manual code
				return await this.events.requestGuardCode(this.accountName);
			}
			return false;
		}, password);

		this.session = session;
		this.steamID = session.steamID.toString();
		this.record.steamID64 = this.steamID;
		this.record.refreshToken = session.refreshToken || this.record.refreshToken;
		this.record.lastLogin = Date.now();
		this._save();

		const cookies = await session.getWebCookies();
		this._setupCommunity(cookies);
		this.log.success(this.accountName, 'Авторизация успешна');
		this._resumeAutoPlay();
		return true;
	}

	// Если вкл. «играть при старте» и есть список игр — поднимаем игровой клиент после входа.
	_resumeAutoPlay() {
		if (!this.autoPlayEnabled || !this.playAppIds.length) return;
		this.log.info(this.accountName, `Автозапуск «игры»: ${this.playAppIds.join(', ')}`);
		this.startPlay(this.playAppIds).catch(err => {
			this.log.warn(this.accountName, `Автоигра не запустилась: ${err.message}`);
		});
	}

	async _awaitAuthentication(session, password, onGuard) {
		return new Promise((resolve, reject) => {
			let authResolved = false;
			let timeout = setTimeout(() => {
				if (!authResolved) {
					reject(new Error('Таймаут аутентификации — проверьте код/подтверждение в приложении Steam'));
				}
			}, 90000);

			const startWithCode = async (code) => {
				return session.startWithCredentials({
					accountName: this.accountName,
					password,
					...((code && { steamGuardCode: code }) || {})
				});
			};

			session.on('authenticated', () => {
				if (authResolved) return;
				authResolved = true;
				clearTimeout(timeout);
				resolve();
			});
			session.on('error', err => {
				if (authResolved) return;
				authResolved = true;
				clearTimeout(timeout);
				reject(err);
			});

			(async () => {
				try {
					const code = this.record.sharedSecret ? SteamTotp.generateAuthCode(this.record.sharedSecret) : undefined;
					let result = await startWithCode(code);

					// If action is still required, we may need a code or approval
					if (result && result.actionRequired) {
						const needCode = (result.validActions || []).some(a => a.type === EAuthSessionGuardType.DeviceCode || a.type === EAuthSessionGuardType.EmailCode);
						if (needCode) {
							const handled = await onGuard(true);
							if (!handled) {
								// abort
								session.cancelLoginAttempt().catch(() => {});
								reject(new Error('Требуется код Steam Guard, но ввод не доступен'));
								return;
							}
						}
					}
				} catch (err) {
					// If the code was wrong, retry with a fresh one from the authenticator once.
					if (this.record.sharedSecret && err.eresult === 88) {
						try {
							await startWithCode(SteamTotp.generateAuthCode(this.record.sharedSecret));
						} catch (err2) {
							reject(err2);
						}
					} else if (err.eresult === 2 || err.eresult === 3 || err.eresult === 5) {
						// 2=Fail, 3=NoConnection, 5=InvalidPassword
						reject(new Error(`Ошибка входа Steam: ${err.message}`));
					} else {
						reject(err);
					}
				}
			})();
		});
	}

	_setupCommunity(cookies) {
		this.cookies = cookies;

		// Extract accessToken from steamLoginSecure cookie
		const loginCookie = cookies.find(c => c.startsWith('steamLoginSecure='));
		if (loginCookie) {
			const m = loginCookie.match(/steamLoginSecure=([^;]+)/);
			if (m) {
				const val = decodeURIComponent(m[1].trim());
				this.accessToken = val.split('||')[1] || val;
			}
		}

		// Сохраняем MobileApp access token — он нужен для подтверждения входов на других устройствах
		if (this.accessToken && this.record.mobileAccessToken !== this.accessToken) {
			this.record.mobileAccessToken = this.accessToken;
			this._save();
		}

		const community = new SteamCommunity(this._proxyCommunityOpts());
		community.setCookies(cookies);

		const manager = new TradeOfferManager({
			community,
			language: 'en',
			pollInterval: 60000,
			pollFullUpdateInterval: 600000,
			useAccessToken: true
		});

		this.community = community;
		this.manager = manager;

		// Bind the community reference used internally to be our instance, then wire events + polling
		manager.setCookies(cookies, (err) => {
			if (err) {
				this.log.warn(this.accountName, `Проблема с привязкой сессии: ${err.message}`);
			} else {
				this._bindManagerEvents();
				this._startPolling();
			}
		});

		this.connected = true;
		this.setStatus('online', 'Онлайн');

		// Загружаем аватар профиля Steam (один раз при входе) — используем в UI
		this._fetchAvatar().catch(() => {});

		this.events.emit('account:status', this.statusPayload());
		this.events.emit('account:connected', this.accountName);
		this.log.success(this.accountName, 'Сессия привязана к Steam Community');
	}

	// Получает ссылку на аватар профиля через SteamCommunity (публичный профиль) и сохраняет в record.
	async _fetchAvatar() {
		if (this.record.avatar || !this.record.steamID64) return;
		try {
			const SteamID = require('steamid');
			const sid = new SteamID(this.record.steamID64);
			const avatar = await new Promise((resolve, reject) => {
				const community = new SteamCommunity(this._proxyCommunityOpts());
				community.getSteamUser(sid, (err, user) => {
					if (err) return reject(err);
					resolve(user && user.getAvatarURL ? user.getAvatarURL('full') : null);
				});
			});
			const normalized = SteamAccount.normalizeAvatar(avatar);
			if (normalized && normalized !== this.record.avatar) {
				this.record.avatar = normalized;
				this._save();
				this.events.emit('account:status', this.statusPayload());
				this.log.success(this.accountName, 'Аватар профиля загружен');
			}
		} catch (err) {
			this.log.warn(this.accountName, `Не удалось загрузить аватар: ${err.message}`);
		}
	}

	_bindManagerEvents() {
		if (!this.manager) return;
		this.manager.on('newOffer', offer => {
			this.log.info(this.accountName, `Новый трейд #${offer.id}`);
			if (this.acceptEnabled && this._shouldAutoAccept(offer)) {
				this.acceptOffer(offer.id).catch(err => {
					this.log.error(this.accountName, `Автоприём #${offer.id}: ${err.message}`);
				});
			}
			this._scheduleOffersRefresh();
		});
		this.manager.on('pollFailure', err => {
			this.log.warn(this.accountName, `Поллинг трейдов: ${err.message}`);
		});
	}

	// Refresh the offer list at most once per window, debounce fast flurries of events.
	_scheduleOffersRefresh(ms, force) {
		clearTimeout(this._offersRefreshTimer);
		this._offersRefreshTimer = setTimeout(() => {
			this._refreshOffers();
		}, ms || (force ? 0 : 2000));
	}

	_startPolling() {
		if (this.polling) return;
		this.polling = true;

		// Confirmations poller — самопланирующийся, со случайным стартовым сдвигом и
		// backoff при ограничении (HTTP 429), чтобы многие аккаунты не стучали в фазе.
		this._confirmLoop();
		this.confirmTimer = null;

		// Periodic offer-list refresh (the TradeOfferManager poll emits newOffer on its own)
		this.offersTimer = setInterval(() => {
			if (!this.connected) return;
			this._refreshOffers();
		}, 90000);

		setTimeout(() => {
			this._pollConfirmations().catch(() => {});
			this._refreshOffers();
		}, 2000);
	}

	// Планирует следующий опрос подтверждений. jitter размазывает запросы, backoff
	// увеличивает паузу, если Steam отвечает 429 (Too Many Requests).
	_confirmLoop() {
		if (!this.polling) return;
		const baseDelay = 30000 + Math.floor(Math.random() * 15000); // 30–45 с
		const delay = this._confirmBackoff != null ? this._confirmBackoff : baseDelay;
		this.confirmTimer = setTimeout(async () => {
			if (!this.connected) { this._confirmLoop(); return; }
			try {
				await this._pollConfirmations();
				this._confirmBackoff = null;
			} catch (err) {
				const tooMany = err && (String(err.message || err).includes('429') || /rate.?limit/i.test(String(err.message || err)));
				if (tooMany) {
					this._confirmBackoff = Math.min((this._confirmBackoff || baseDelay) * 2, 180000);
					this.log.warn(this.accountName, `Steam ограничил запросы (429), следующая проверка через ${Math.round(this._confirmBackoff / 1000)}с`);
				} else if (err.message !== 'Not Logged In') {
					this.log.warn(this.accountName, `Проверка подтверждений: ${err.message}`);
				}
			}
			this._confirmLoop();
		}, delay);
	}

	stop() {
		this.connected = false;
		this.polling = false;
		if (this.confirmTimer) clearInterval(this.confirmTimer);
		if (this.offersTimer) clearInterval(this.offersTimer);
		if (this._offersRefreshTimer) clearTimeout(this._offersRefreshTimer);
		if (this.manager) this.manager.stopPolling && this.manager.stopPolling();

		// Останавливаем игровой клиент, если он есть
		if (this.playClient) {
			try { this.playClient.logOff(); } catch (e) {}
			this.playClient.removeAllListeners();
			this.playClient = null;
		}
		if (this.cs2) { this.cs2.removeAllListeners && this.cs2.removeAllListeners(); this.cs2 = null; }
		if (this.cs2Cell) { this.cs2Cell = null; }
		if (this._playRetryTimer) { clearTimeout(this._playRetryTimer); this._playRetryTimer = null; }

		this.setStatus('offline', 'Оффлайн');

		try { if (this.session && this.session.cancelLoginAttempt) this.session.cancelLoginAttempt(); } catch (e) {}
		this.log.info(this.accountName, 'Аккаунт отключён');
	}

	// ─── Confirmations ────────────────────────────────────────────────────

	// EConfirmationType (SteamTracking / enums.steamd):
	// Test=1, Trade=2, MarketSell=3, FeatureOptOut=4, PhoneNumberChange=5, AccountRecovery=6,
	// ApiKeyCreation=9, JoinSteamFamily=11. Входа на новое устройство в списке mobileconf НЕТ —
	// такие запросы приходят как device-confirmation auth-сессии и обрабатываются через
	// IAuthenticationService/GetAuthSessionsForAccount (см. listPendingLogins).
	static CONFIRMATION_TYPES = {
		1: 'Тест',
		2: 'Обмен',
		3: 'Продажа на маркете',
		4: 'Feature Opt-Out',
		5: 'Смена телефона',
		6: 'Восстановление аккаунта',
		7: 'Восстановление аккаунта',
		8: 'Подтверждение почты',
		9: 'Создание API-ключа',
		10: 'Телефон',
		11: 'Steam Family'
	};

	async _pollConfirmations() {
		if (!this.connected || !this.community || !this.record.identitySecret) return;

		const time = SteamTotp.time();
		const key = SteamTotp.getConfirmationKey(this.record.identitySecret, time, 'list');

		const confs = await new Promise((resolve, reject) => {
			this.community.getConfirmations(time, { tag: 'list', key }, (err, list) => {
				if (err) return reject(err);
				resolve(list || []);
			});
		});

		// map to plain objects
		this.confirmations = confs.map(conf => {
			const typeLabel = SteamAccount.CONFIRMATION_TYPES[conf.type] || `Тип ${conf.type}`;
			return {
				id: conf.id,
				type: conf.type,
				typeLabel,
				creator: conf.creator,
				key: conf.key,
				title: conf.title || typeLabel,
				receiving: conf.receiving || '',
				sending: conf.sending || ''
			};
		});

		this.events.emit('account:confirmations', { account: this.accountName, confirmations: this.confirmations });

		if (this.confirmations.length > 0) {
			this.log.info(this.accountName, `Подтверждений ожидает: ${this.confirmations.length}`);
		}

		if (this.confirmEnabled && this.confirmations.length > 0) {
			await this.acceptAllConfirmations({ skipLogin: true });
		}
	}

	async acceptAllConfirmations(options = {}) {
		if (!this.connected || !this.record.identitySecret) throw new Error('Нет identity_secret');
		const skipLogin = !!(options.skipLogin);
		const time = SteamTotp.time();
		const key = SteamTotp.getConfirmationKey(this.record.identitySecret, time, 'list');

		let confs = await new Promise((resolve, reject) => {
			this.community.getConfirmations(time, { tag: 'list', key }, (err, list) => {
				if (err) return reject(err);
				resolve(list || []);
			});
		});

		// "Принять все" из интерфейса подтверждает всё, включая подтверждения входа, если они вдруг появятся
		// в списке mobileconf. Автоматический режим оставляет их человеку (подтверждается через кнопку входа).
		if (skipLogin) {
			confs = confs.filter(c => c.type !== 12);
		}

		if (!confs.length) return [];

		const acceptTime = SteamTotp.time();
		const accepted = await new Promise((resolve, reject) => {
			this.community.respondToConfirmation(confs.map(c => c.id), confs.map(c => c.key), acceptTime, { tag: 'accept', key: SteamTotp.getConfirmationKey(this.record.identitySecret, acceptTime, 'accept') }, true, (err) => {
				if (err) return reject(err);
				resolve(confs);
			});
		});

		if (accepted.length) {
			this.log.success(this.accountName, `Подтверждено: ${accepted.length}`);
			this.events.emit('account:confirmations', { account: this.accountName, confirmations: [] });
		}
		return accepted;
	}

	async respondConfirmation(confId, confKey, accept) {
		const time = SteamTotp.time();
		const key = SteamTotp.getConfirmationKey(this.record.identitySecret, time, accept ? 'accept' : 'reject');
		await new Promise((resolve, reject) => {
			this.community.respondToConfirmation(confId, confKey, time, { tag: accept ? 'accept' : 'reject', key }, accept, (err) => {
				if (err) return reject(err);
				resolve();
			});
		});
		this._pollConfirmations().catch(() => {});
	}

	// ─── Steam Guard code (2FA code shown in the UI, like the mobile app) ─

	getGuardCode() {
		if (!this.record.sharedSecret) return null;
		return {
			code: SteamTotp.generateAuthCode(this.record.sharedSecret),
			remaining: 30 - (Math.floor(Date.now() / 1000) % 30)
		};
	}

	// ─── Login confirmation (approve sign-in on another device) ──────────

	// Mobile-app style: Steam exposes ALL active auth-sessions for an account via
	// IAuthenticationService/GetAuthSessionsForAccount. When you log in somewhere
	// with login+password, Steam creates a session guarded by DeviceConfirmation —
	// without any QR or links. We enumerate those sessions and offer one-tap approve.
	async listPendingLogins() {
		const token = await this._resolveMobileAccessToken();
		const clientIds = await steamAuthWebapi.listAuthSessions(token);
		const logins = [];
		for (const clientId of clientIds) {
			try {
				const info = await steamAuthWebapi.getAuthSessionInfo(token, clientId);
				const version = (typeof info.version === 'number' && info.version !== 0)
					? info.version
					: 1; // WebAPI может не вернуть version — challenge version по умолчанию 1
				logins.push({
					clientId,
					version,
					info: {
						ip: info.ip,
						location: { geoloc: info.geoloc, city: info.city, state: info.state },
						platformType: info.platformType,
						deviceFriendlyName: info.deviceFriendlyName
					}
				});
			} catch (e) {
				// ignore sessions that fail to load — most likely already resolved
			}
		}
		return logins;
	}

	async approveLoginByClientId(clientId, version, approve) {
		const token = await this._resolveMobileAccessToken();

		// Показываем что именно уходит на подпись — помогает отладить 121 InvalidSignature.
		const steamId = steamAuthWebapi.decodeJwt(token).sub;
		try {
			await steamAuthWebapi.updateAuthSessionWithMobileConfirmation(token, this.record.sharedSecret, {
				clientId,
				version,
				steamId,
				approve
			});
		} catch (err) {
			err.message += ` (account=${this.accountName}, clientId=${clientId}, version=${version}, steamId=${steamId})`;
			throw err;
		}
		this.log.success(this.accountName, approve ? 'Вход подтверждён' : 'Вход отклонён');
		return true;
	}

	// Возвращает валидный MobileApp access token. Если он не сохранён или устарел,
	// выводим свежий из refresh token и кладём обратно в рекорд.
	async _resolveMobileAccessToken() {
		if (this.record.mobileAccessToken) return this.record.mobileAccessToken;
		if (!this.record.refreshToken) {
			throw new Error('Нет MobileApp access token / refresh-токена — перелогиньтесь');
		}
		const session = new LoginSession(EAuthTokenPlatformType.MobileApp, this._proxySteamOpts());
		session.refreshToken = this.record.refreshToken;
		await session.refreshAccessToken();
		if (!session.accessToken) throw new Error('Не удалось обновить access token');
		this.record.mobileAccessToken = session.accessToken;
		this._save();
		return session.accessToken;
	}

	// ─── Играть в игры (как ArchiSteamFarm) ──────────────────────────────
	// Поднимает SteamKit-клиент (steam-user) к CM-серверам и сообщает «играю в appIds».
	// Часы копятся на стороне Steam с задержкой; статус «в игре» виден сразу.

	_emitPlayStatus() {
		this.events.emit('account:status', this.statusPayload());
	}

	// Наивный признак «аккаунт сейчас играет»
	isPlaying() {
		return this.playStatus.state === 'playing';
	}

	// Записать желаемый список игр + признак «играть при старте» (без запуска клиента)
	async setAutoPlay(enabled) {
		this.autoPlayEnabled = !!enabled;
		if (enabled && !this.playAppIds.length) {
			this.autoPlayEnabled = false;
			throw new Error('Сначала укажите хотя бы одну игру');
		}
		this.record.autoPlay = this.autoPlayEnabled;
		this.record.playGames = this.playAppIds;
		this._save();
		this._emitPlayStatus();
		this.log.info(this.accountName, this.autoPlayEnabled ? 'Автоигра включена' : 'Автоигра выключена');
		return this.statusPayload();
	}

	startPlay(appIds) {
		const clean = Array.from(new Set((Array.isArray(appIds) ? appIds : [appIds]).map(a => Number(a)).filter(n => n > 0)));
		if (!clean.length) throw new Error('Укажите хотя бы одну игру (appID)');
		this.playAppIds = clean;
		this.record.playGames = clean;
		this._save();
		this.log.info(this.accountName, `Запуск «игры»: ${clean.join(', ')}`);
		return this._ensurePlayClient();
	}

	stopPlay() {
		this.playAppIds = [];
		this.record.playGames = [];
		if (this._playRetryTimer) { clearTimeout(this._playRetryTimer); this._playRetryTimer = null; }
		if (this.playClient) {
			try {
				this.playClient.gamesPlayed([]);
				this.playClient.logOff();
			} catch (e) { /* ignore */ }
			this.playClient.removeAllListeners();
			this.playClient = null;
		}
		this.playStatus = { state: 'stopped', games: [], label: 'Не играет' };
		this._save();
		this._emitPlayStatus();
		this.log.info(this.accountName, '«Игра» остановлена');
		return this.statusPayload();
	}

	// Гарантирует запущенный steam-user клиент, играющий в определённые игры.
	// gameIds (необязательно) — список appID желаемых. По умолчанию this.playAppIds.
	// Переоткрывает клиент при сетевых сбоях (с задержкой, без спама).
	async _ensurePlayClient(gameIds) {
		const games = Array.isArray(gameIds) ? gameIds.map(Number).filter(n => n > 0) : this.playAppIds;
		// gameIds == null => это вызов из «Играть»: игры заданы настройками аккаунта.
		const fromSettings = !Array.isArray(gameIds);

		if (this.playClient && (this.playClient.steamID || this.playClient._loggedOn)) {
			try { this.playClient.setPersona(SteamUser.EPersonaState.Online); } catch (e) { /* ignore */ }
			this.playClient.gamesPlayed(games);
			this.playStatus = { state: 'playing', games, label: `Играет: ${games.join(', ')}` };
			this._emitPlayStatus();
			return this.statusPayload();
		}

		if (this._playRetryTimer) { clearTimeout(this._playRetryTimer); this._playRetryTimer = null; }
		const client = new SteamUser({
			enablePicsCache: false,
			autoRelogin: false,
			...this._proxySteamOpts()
		});
		this.playClient = client;
		this.playStatus = { state: 'connecting', games, label: 'Подключение к Steam…' };
		this._emitPlayStatus();

		return new Promise((resolve, reject) => {
			let settled = false;
			const done = (fn, val) => { if (settled) return; settled = true; fn(val); };
			const timeout = setTimeout(() => {
				const err = new Error('Подключение игрового клиента к Steam: таймаут (15с)');
				this.playStatus = { state: 'error', games: [], label: `Ошибка: ${err.message}` };
				this._emitPlayStatus();
				cleanup();
				done(reject, err);
			}, 15000);
			const cleanup = () => { clearTimeout(timeout); };

			client.on('loggedOn', async () => {
				cleanup();
				try {
					client.setPersona(SteamUser.EPersonaState.Online);
					client.gamesPlayed(games);
					this.playStatus = { state: 'playing', games, label: `Играет: ${games.join(', ')}` };
				} catch (e) {
					this.playStatus = { state: 'error', games: [], label: `Ошибка: ${e.message}` };
				}
				this._emitPlayStatus();
				done(resolve, this.statusPayload());
			});

			client.on('error', (err) => {
				this.log.warn(this.accountName, `Игровой клиент: ${err.message}`);
				this.playStatus = { state: 'error', games: [], label: `Ошибка: ${err.message}` };
				this._emitPlayStatus();
				cleanup();
				done(reject, err);
			});

			client.on('steamGuard', async (domain, callback, lastCodeWrong) => {
				const code = this.record.sharedSecret ? SteamTotp.generateAuthCode(this.record.sharedSecret) : null;
				if (code) callback(code);
				else callback(null, true); // нужен ручной код — пока не поддерживается
			});

			client.on('disconnected', (eresult, msg) => {
				this.log.warn(this.accountName, `Игровой клиент отключён: ${msg || eresult}`);
			});

			// steam-user может обновить наш SteamClient refresh-токен — сохраняем, чтобы
			// при следующем запуске входить без пароля.
			client.on('refreshToken', (token) => {
				if (token && token !== this.record.steamClientRefreshToken) {
					this.record.steamClientRefreshToken = token;
					this._save();
				}
			});

			this._logonPlayClient(client).catch(err => {
				this.log.warn(this.accountName, `Логин игрового клиента: ${err.message}`);
				this.playStatus = { state: 'error', games: [], label: `Ошибка входа: ${err.message}` };
				this._emitPlayStatus();
				cleanup();
				done(reject, err);
			});
		});
	}

	// ─── CS2 Trade-Up контракты (без запуска игры) ──────────────────────
	// Используем play-клиент (steam-user): чтобы подключиться к игровому координатору CS2,
	// клиент должен «играть» в CS2 (appid 730). Далее globaloffensive.craft(items, recipe)
	// выполняет контракт обмена (10 предметов одной редкости -> 1 предмет редкости выше).

	// CS2 Rarity (из тегов инвентаря) → id рецепта Trade-Up.
	static CS2_RARITY = {
		Rarity_Common: 0,        // Consumer Grade → Industrial
		Rarity_Uncommon: 1,      // Industrial → Mil-Spec
		Rarity_Rare: 2,          // Mil-Spec → Restricted
		Rarity_Mythical: 3,      // Restricted → Classified
		Rarity_Legendary: 4,     // Classified → Covert
		// StatTrak-рецепты — те же, но +10 (обрабатывается отдельно).
		// Rarity_Ancient → 5 (Covert): не участвует в контрактах, но показывается в UI.
		Rarity_Ancient: 5
	};
	static CS2_RARITY_NAMES = {
		0: 'Consumer Grade',
		1: 'Industrial Grade',
		2: 'Mil-Spec Grade',
		3: 'Restricted',
		4: 'Classified',
		5: 'Covert'
	};
	static CS2_QUALITY_STATRAK = 'stat_trak';

	// В CS2 internal_name тегов Rarity может иметь суффикс типа "_Weapon"
	// (Rarity_Rare_Weapon, Rarity_Ancient_Weapon...), а у стикеров/прочего —
	// без суффикса (Rarity_Rare и т.д.). Сопоставляем по префиксу.
	static cs2RarityFromTag(internalName) {
		if (!internalName) return undefined;
		for (const prefix of Object.keys(SteamAccount.CS2_RARITY)) {
			if (internalName.startsWith(prefix)) return SteamAccount.CS2_RARITY[prefix];
		}
		return undefined;
	}

	// Гарантирует, что play-клиент залогинен и «играет» в CS2, и что GlobalOffensive
	// подключён к GC CS2. Возвращает cs2 (GlobalOffensive). Не меняет настройки «Играть».
	async _ensureCs2Client() {
		this._cs2HadPlayBefore = !!(this.playClient && (this.playClient.steamID || this.playClient._loggedOn));

		// 1) Поднимаем play-клиент, играя ВСЁ КРОМЕ 730. 730 запускаем ПОСЛЕ
		//    создания GlobalOffensive, иначе appLaunched(730) может сработать во
		//    время логина (до конструирования cs2) и GC никогда не получит hello.
		const baseGames = this.playAppIds.filter(g => g !== 730);
		await this._ensurePlayClient(baseGames);

		// 2) GlobalOffensive должен существовать ДО запуска 730 и быть привязан
		//    к текущему play-клиенту (иначе он слушает «мёртвого» клиента).
		if (!this.cs2 || this.cs2._steam !== this.playClient) {
			this.cs2 = new GlobalOffensive(this.playClient);
			this.cs2.on('error', (err) => {
				this.log.warn(this.accountName, `CS2 GC: ${err.message}`);
			});
			this.cs2.on('debug', (msg) => {
				this.log.debug(this.accountName, `CS2 GC: ${msg}`);
			});
		}
		if (this.cs2.haveGCSession) return this.cs2;

		// 3) Запускаем 730 и принудительно инициируем handshake GC. Явный _connect()
		//    нужен, т.к. appLaunched(730) может не дойти (гонки инициализации или
		//    guard `if (this._isInCSGO) return` внутри GlobalOffensive).
		const wanted = Array.from(new Set([...this.playAppIds, 730]));
		try { this.playClient.gamesPlayed(wanted); } catch (e) { /* ignore */ }
		this.playStatus = { state: 'playing', games: wanted, label: `Играет: ${wanted.join(', ')}` };
		this._emitPlayStatus();

		this.cs2._isInCSGO = true;
		if (!this.cs2.haveGCSession) {
			try { this.cs2._connect(); } catch (e) { /* ignore */ }
		}

		this.cs2Cell = new Promise((resolve, reject) => {
			if (this.cs2.haveGCSession) return resolve();
			const timeout = setTimeout(() => {
				clearTimeout(timeout);
				reject(new Error('Таймаут подключения к серверам CS2'));
			}, 60000);
			this.cs2.once('connectedToGC', () => { clearTimeout(timeout); resolve(); });
			this.cs2.once('error', (err) => { clearTimeout(timeout); reject(err); });
		});
		await this.cs2Cell;
		return this.cs2;
	}

	// Возвращает инвентарь CS2 (context 2) с картой редкостей для контрактов.
	// Требует подключения к GC (нужно для крафта). Для простого просмотра/подсчёта
	// используйте cs2InventoryWeb() — он не трогает play-клиент и GC.
	async cs2GetInventory() {
		await this._ensureCs2Client();
		if (!this.manager) throw new Error('Аккаунт не подключён');
		// GC-инвентарь (с реальным paint_wear) приходит чуть позже установления
		// сессии — подождём его, чтобы float входов был доступен сразу.
		await this._waitCs2Inventory();
		return this._mapCs2Items(await this._cs2FetchItems());
	}

	_waitCs2Inventory(timeout = 4000) {
		return new Promise(resolve => {
			const cs2 = this.cs2;
			if (!cs2 || !cs2.haveGCSession) return resolve();
			if (Array.isArray(cs2.inventory) && cs2.inventory.length) return resolve();
			const start = Date.now();
			const iv = setInterval(() => {
				if (!this.cs2 || (Array.isArray(this.cs2.inventory) && this.cs2.inventory.length) || Date.now() - start > timeout) {
					clearInterval(iv);
					resolve();
				}
			}, 100);
		});
	}

	// Чистый список предметов CS2 через веб-сессию (без GC). Быстрее и не меняет
	// статус «в игре». Используется для сводного подсчёта стоимости.
	async cs2InventoryWeb() {
		if (!this.manager) throw new Error('Аккаунт не подключён');
		return this._mapCs2Items(await this._cs2FetchItems());
	}

	async _cs2FetchItems() {
		return new Promise((resolve, reject) => {
			this.manager.getInventoryContents(730, '2', false, (err, items) => {
				if (err) return reject(err);
				resolve(items || []);
			});
		});
	}

	_mapCs2Items(items) {
		// Game Coordinator inventory always carries the real paint_wear (float),
		// unlike the Steam web inventory which often omits it. Merge it in by assetid.
		const gcMap = new Map();
		if (this.cs2 && Array.isArray(this.cs2.inventory)) {
			for (const g of this.cs2.inventory) {
				if (g && g.id != null && g.paint_wear != null) {
					gcMap.set(String(g.id), g.paint_wear);
				}
			}
		}
		return items.map(i => {
			const rarityTag = i.getTag && i.getTag('Rarity');
			const qualityTag = i.getTag && i.getTag('Quality');
			const statTrak = /stat|stat_trak/i.test((qualityTag && qualityTag.internal_name) || (qualityTag && qualityTag.name) || '') || /StatTrak/i.test(i.market_name || '');
			const rarity = SteamAccount.cs2RarityFromTag(rarityTag && rarityTag.internal_name);
			const mhn = i.market_hash_name || i.market_name || '';
			const typeTag = (i.getTag && i.getTag('Type'));
			const typeName = (typeTag && typeTag.internal_name) || '';
			// В контрактах Trade-Up участвуют только предметы оружия. Наклейки, капсулы,
			// брелки (Charm/Keychain), граффити, кейсы, пин-коды и т.п. — исключаем.
			let kind = 'weapon';
			if (
				/sticker|capsule|charm|keychain|graffiti|music ?kit|collectible|agent|pin/i.test(mhn) ||
				/case$/i.test(mhn) ||
				/sticker|capsule|charm|keychain|graffiti|musickit|collectible|agent|case|pin/i.test(typeName)
			) {
				kind = 'other';
			}
			const ap = (i.asset_properties && typeof i.asset_properties === 'object') ? i.asset_properties : {};
			const rawFloat = (i.float != null) ? i.float
				: (ap.float != null) ? ap.float
				: (ap.paint_wear != null) ? ap.paint_wear
				: (ap.paintwear != null) ? ap.paintwear
				: (i.floatvalue != null) ? i.floatvalue
				: null;
			// Fallback to Game Coordinator paint_wear (keyed by assetid).
			let finalFloat = rawFloat;
			if (finalFloat == null) {
				const gf = gcMap.get(String(i.assetid));
				if (gf != null) finalFloat = gf;
			}
			const rawSeed = (i.paintseed != null) ? i.paintseed : (ap.paintseed != null ? ap.paintseed : null);
			const exteriorTag = i.getTag && i.getTag('Exterior');
			return {
				assetid: i.assetid,
				amount: i.amount,
				marketName: i.market_name || i.name || String(i.assetid),
				marketHashName: i.market_hash_name || null,
				icon: i.icon_url ? i.getImageURL() : null,
				float: (finalFloat != null && Number.isFinite(parseFloat(finalFloat))) ? parseFloat(finalFloat) : null,
				paintseed: (rawSeed != null && Number.isFinite(parseFloat(rawSeed))) ? parseFloat(rawSeed) : null,
				exterior: (exteriorTag && exteriorTag.name) ? exteriorTag.name : null,
				tradable: i.tradable !== false,
				rarity: rarity,
				rarityLabel: SteamAccount.CS2_RARITY_NAMES[rarity],
				rarityName: (rarityTag && rarityTag.name) || SteamAccount.CS2_RARITY_NAMES[rarity],
				kind,
				statTrak,
				recipe: (rarity !== null && rarity !== undefined && rarity !== 5) ? rarity + (statTrak ? 10 : 0) : -1
			};
		}).filter(i => i.kind === 'weapon');
	}

	// Резолвим точный market_hash_name через поиск маркета. Сконструированные
	// имена (особенно «Base Grade» и прочие non-standard суффиксы) могут не
	// совпадать с реальным именем Steam, из-за чего priceoverview отдаёт {}.
	// Кэш на время жизни процесса, чтобы не дёргать поиск повторно.
	async cs2ResolveHash(query) {
		if (SteamAccount._cs2HashCache.has(query)) return SteamAccount._cs2HashCache.get(query);
		let hash = null;
		try {
			const qs = new URLSearchParams({ query, appid: '730', count: '1' });
			const u = 'https://steamcommunity.com/market/search/render/?' + qs.toString();
			const { statusCode, body } = await SteamAccount._httpGet(u, {
				'User-Agent': 'Mozilla/5.0',
				'Accept': 'application/json'
			});
			if (statusCode === 200) {
				const json = JSON.parse(body);
				const html = (json && json.results_html) || '';
				let m = html.match(/data-hash-name="([^"]+)"/);
				if (!m) m = html.match(/\/market\/listings\/730\/([^"?'<>\s]+)/);
				if (m) hash = decodeURIComponent(m[1].replace(/\+/g, ' '));
			}
		} catch (e) { /* ignore */ }
		SteamAccount._cs2HashCache.set(query, hash);
		return hash;
	}

	// Кэш курса USD->RUB на время процесса.
	static _usdRubRate = null;

	// Простой HTTPS-GET, возвращающий { statusCode, body }. Точка входа для
	// внешних запросов цен и курса валют. Разрешение имён идёт через подменённый
	// dns.lookup (DoH), так что работает и при кривом провайдерском DNS.
	// Следует за редиректами (301/302/307/308); при смене хоста не передаёт
	// заголовок Authorization, чтобы не слить ключ Pricempire/SteamApis.
	static _httpGet(uri, headers, timeoutMs = 15000, redirects = 5) {
		return new Promise((resolve, reject) => {
			const url = new URL(uri);
			const lib = url.protocol === 'http:' ? http : https;
			const req = lib.get({
				hostname: url.hostname,
				path: url.pathname + url.search,
				headers: Object.assign({ 'User-Agent': 'Mozilla/5.0' }, headers || {})
			}, (res) => {
				const status = res.statusCode;
				if ((status === 301 || status === 302 || status === 307 || status === 308) && redirects > 0 && res.headers.location) {
					res.resume();
					let next = res.headers.location;
					if (!/^https?:\/\//i.test(next)) {
						next = new URL(next, `${url.protocol}//${url.host}`).toString();
					}
					const sameHost = new URL(next).hostname === url.hostname;
					const nextHeaders = Object.assign({}, headers);
					if (!sameHost) delete nextHeaders['Authorization'];
					getLogger('app').debug(`_httpGet редирект ${status} ${uri} -> ${next}`);
					resolve(SteamAccount._httpGet(next, nextHeaders, timeoutMs, redirects - 1));
					return;
				}
				let body = '';
				res.setEncoding('utf8');
				res.on('data', (c) => { body += c; });
				res.on('end', () => resolve({ statusCode: status, body }));
			});
			req.on('error', (e) => reject(new Error(`${e.message} (${uri})`)));
			req.setTimeout(timeoutMs, () => req.destroy(new Error('http timeout')));
		});
	}

	// ---- Иконки предметов (для выходов Trade-Up) ----
	static CS2_ICON_CACHE = new Map();
	static CS2_ICON_CACHE_FILE = 'cs2-icons.json';

	static _loadIconCache() {
		if (SteamAccount.CS2_ICON_CACHE.size) return;
		try {
			const file = path.join(APP_DATA, SteamAccount.CS2_ICON_CACHE_FILE);
			const data = JSON.parse(fs.readFileSync(file, 'utf8'));
			for (const [k, v] of Object.entries(data || {})) SteamAccount.CS2_ICON_CACHE.set(k, v);
		} catch (e) { /* пусто */ }
	}

	static _saveIconCache() {
		try {
			const file = path.join(APP_DATA, SteamAccount.CS2_ICON_CACHE_FILE);
			fs.mkdirSync(APP_DATA, { recursive: true });
			const obj = {};
			for (const [k, v] of SteamAccount.CS2_ICON_CACHE) obj[k] = v;
			fs.writeFileSync(file, JSON.stringify(obj));
		} catch (e) { /* ignore */ }
	}

	// Возвращает CDN-URL иконки скина (износонезависимая). Кэшируется в файл.
	async cs2ItemIcon(skinName) {
		const base = String(skinName || '').replace(/\s*\|\s*/g, ' ').replace(/\s+/g, ' ').trim();
		if (!base) return null;
		SteamAccount._loadIconCache();
		if (SteamAccount.CS2_ICON_CACHE.has(base)) return SteamAccount.CS2_ICON_CACHE.get(base);
		let url = null;
		try {
			const qs = new URLSearchParams({ query: base, appid: '730', count: '1' });
			const u = 'https://steamcommunity.com/market/search/render/?' + qs.toString();
			const { statusCode, body } = await SteamAccount._httpsGet(u, { 'User-Agent': 'Mozilla/5.0' });
			if (statusCode !== 200) throw new Error('HTTP ' + statusCode);
			const html = (JSON.parse(body).results_html) || '';
			const m = html.match(/<img id="result_0_image"[^>]*src="https:\/\/[^"]*?\/economy\/image\/([^/"'<> ]+)/);
			if (m) url = `https://community.fastly.steamstatic.com/economy/image/${m[1]}/128fx128f`;
		} catch (e) { /* ignore */ }
		SteamAccount.CS2_ICON_CACHE.set(base, url);
		SteamAccount._saveIconCache();
		return url;
	}

	// CS2 Trade-Up: статические данные о коллекциях и редкостях из внешних источников.
	static CS2_RARITY_BY_NAME = { common: 0, uncommon: 1, rare: 2, rare_2: 2, mythical: 3, legendary: 4, ancient: 5 };
	static CS2_TRADEUP_DB = null;
	static CS2_TRADEUP_DB_FILE = 'cs2-tradeup-db-v2.json';
	static CS2_TRADEUP_DB_URL_SKINS = 'https://raw.githubusercontent.com/unicbm/cs2-econ-id-index/main/data/weapon-skins.json';
	static CS2_TRADEUP_DB_URL_SETS = 'https://raw.githubusercontent.com/unicbm/cs2-econ-id-index/main/data/item-sets.json';
	static CS2_TRADEUP_DB_URL_SKINS_FB = 'https://cdn.jsdelivr.net/gh/unicbm/cs2-econ-id-index@main/data/weapon-skins.json';
	static CS2_TRADEUP_DB_URL_SETS_FB = 'https://cdn.jsdelivr.net/gh/unicbm/cs2-econ-id-index@main/data/item-sets.json';
	static CS2_TRADEUP_DB_URL_PK = 'https://raw.githubusercontent.com/unicbm/cs2-econ-id-index/main/data/paint-kits.json';
	static CS2_TRADEUP_DB_URL_PK_FB = 'https://cdn.jsdelivr.net/gh/unicbm/cs2-econ-id-index@main/data/paint-kits.json';

	// Границы экстерьеров (wear) по float, универсальные для CS2.
	static CS2_WEAR = [
		{ label: 'Factory New', short: 'FN', max: 0.07 },
		{ label: 'Minimal Wear', short: 'MW', max: 0.15 },
		{ label: 'Field-Tested', short: 'FT', max: 0.38 },
		{ label: 'Well-Worn', short: 'WW', max: 0.45 },
		{ label: 'Battle-Scarred', short: 'BS', max: 1.0 }
	];

	static cs2ExteriorFor(floatVal) {
		const f = Number(floatVal);
		for (const w of SteamAccount.CS2_WEAR) {
			if (f < w.max) return { label: w.label, short: w.short };
		}
		return { label: 'Battle-Scarred', short: 'BS' };
	}

	static _fetchText(url) {
		const urls = Array.isArray(url) ? url : [url];
		return new Promise((resolve, reject) => {
			const tryOne = (i) => {
				if (i >= urls.length) return reject(new Error('Не удалось загрузить (все источники недоступны)'));
				const u = urls[i];
				SteamAccount._httpsGet(u, { 'User-Agent': 'Mozilla/5.0' })
					.then(({ statusCode, body }) => {
						if (statusCode !== 200) return tryOne(i + 1);
						resolve(body);
					})
					.catch(() => tryOne(i + 1));
			};
			tryOne(0);
		});
	}

	// Обёртка над https.get с корректной распаковкой сжатия (Steam отдаёт ответы
	// в gzip/deflate/br, иначе JSON.parse падает и цены не парсятся).
	static _httpsGet(url, headers) {
		return new Promise((resolve, reject) => {
			const req = https.get(url, { headers: Object.assign({ 'User-Agent': 'Mozilla/5.0' }, headers || {}) }, (res) => {
				const enc = String(res.headers['content-encoding'] || '').toLowerCase();
				let stream = res;
				if (enc === 'gzip' || enc === 'x-gzip') stream = zlib.createGunzip();
				else if (enc === 'deflate') stream = zlib.createInflate();
				else if (enc === 'br') stream = zlib.createBrotliDecompress();
				if (stream !== res) res.pipe(stream);
				let body = '';
				stream.on('data', d => { body += d; });
				stream.on('end', () => resolve({ statusCode: res.statusCode, body }));
				stream.on('error', reject);
			});
			req.on('error', reject);
			req.setTimeout(15000, () => req.destroy(new Error('timeout')));
		});
	}

	static async _ensureTradeupDB() {
		if (SteamAccount.CS2_TRADEUP_DB) return SteamAccount.CS2_TRADEUP_DB;
		const file = path.join(APP_DATA, SteamAccount.CS2_TRADEUP_DB_FILE);
		try {
			const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
			SteamAccount.CS2_TRADEUP_DB = cached;
			return cached;
		} catch (e) { /* скачать */ }

		try {
			const skinsRaw = await SteamAccount._fetchText([SteamAccount.CS2_TRADEUP_DB_URL_SKINS, SteamAccount.CS2_TRADEUP_DB_URL_SKINS_FB]);
			const setsRaw = await SteamAccount._fetchText([SteamAccount.CS2_TRADEUP_DB_URL_SETS, SteamAccount.CS2_TRADEUP_DB_URL_SETS_FB]);
			const ws = JSON.parse(skinsRaw);
			const ss = JSON.parse(setsRaw);

			const skins = {};
			const entries = Object.values(ws.items);
			for (const e of entries) {
				if (!e || !e.weapon_name || !e.weapon_name.en || !e.paint_name || !e.paint_name.en) continue;
				const k = e.weapon_name.en + ' | ' + e.paint_name.en;
				skins[k] = {
					weapon: e.weapon_name.en,
					paint: e.paint_name.en,
					rarity: e.rarity,
					collections: Array.isArray(e.collections) ? e.collections : [],
					weapon_schema: e.weapon_schema,
					paintKit: e.paint_kit
				};
			}

			// Диапазоны float (wear_remap_min/max) каждого скина — нужны для расчёта
			// итогового экстерьера выхода контракта.
			try {
				const pkRaw = await SteamAccount._fetchText([SteamAccount.CS2_TRADEUP_DB_URL_PK, SteamAccount.CS2_TRADEUP_DB_URL_PK_FB]);
				const pk = JSON.parse(pkRaw);
				const pkItems = pk.items || pk;
				for (const s of Object.values(skins)) {
					const pkEntry = pkItems[String(s.paintKit)];
					const mn = pkEntry && pkEntry.wear_remap_min != null ? parseFloat(pkEntry.wear_remap_min) : NaN;
					const mx = pkEntry && pkEntry.wear_remap_max != null ? parseFloat(pkEntry.wear_remap_max) : NaN;
					if (Number.isFinite(mn) && Number.isFinite(mx) && mx > mn) {
						s.floatMin = mn; s.floatMax = mx;
					} else {
						s.floatMin = 0; s.floatMax = 1;
					}
				}
			} catch (e) {
				this.log.warn(this.accountName, `CS2 TradeUp DB: не удалось загрузить paint-kits (float-капы) — ${e.message}`);
				for (const s of Object.values(skins)) { s.floatMin = 0; s.floatMax = 1; }
			}
			const sets = {};
			const sItems = ss.items || ss;
			for (const token of Object.keys(sItems)) {
				const s = sItems[token];
				if (s && s.name && s.name.en) sets[token] = { name: s.name.en, is_collection: !!s.is_collection };
			}
			const db = { skins, sets, snapshot: ws.snapshot_date || ss.snapshot_date || null };
			try { fs.mkdirSync(APP_DATA, { recursive: true }); fs.writeFileSync(file, JSON.stringify(db)); } catch (e) { /* ignore */ }
			SteamAccount.CS2_TRADEUP_DB = db;
			return db;
		} catch (e) {
			this.log.warn(this.accountName, `CS2 TradeUp DB: не удалось загрузить — ${e.message}`);
			return null;
		}
	}

	static _normalizeSkinName(mhn) {
		return String(mhn || '')
			.replace(/StatTrak™\s*/g, '')
			.replace(/\s*★\s*/g, '')
			.replace(/\s*\([^)]*\)\s*$/, '')
			.trim();
	}

	// Возвращает список возможных выходных предметов Trade-Up для выбранных скинов:
	// [{ name, weapon, paint, rarity, qualityLabel, collections, percent }]
	async cs2TradeupOutput(inputs) {
		const db = await SteamAccount._ensureTradeupDB();
		if (!db) throw new Error('Не удалось загрузить базу данных Trade-Up контрактов');
		const inputItems = Array.isArray(inputs) ? inputs : [];
		const entries = [];
		// Нормализованный средний float входов — основа расчёта экстерьера выхода.
		const inputNorms = [];
		for (const raw of inputItems) {
			const name = typeof raw === 'string' ? raw : (raw && raw.name);
			const fl = (raw && typeof raw === 'object') ? raw.float : null;
			const k = SteamAccount._normalizeSkinName(name);
			const e = db.skins[k];
			if (!e) continue;
			entries.push(e);
			if (fl != null && Number.isFinite(parseFloat(fl))) {
				const f = parseFloat(fl);
				const span = e.floatMax - e.floatMin;
				let n = span > 0 ? (f - e.floatMin) / span : 0;
				n = Math.max(0, Math.min(1, n));
				inputNorms.push(n);
			}
		}
		if (!entries.length) throw new Error('Не удалось определить коллекцию для выбранных предметов (они могли быть удалены из базы или не являются скинами оружия)');

		const raritySet = new Set(entries.map(e => e.rarity));
		if (raritySet.size !== 1) throw new Error('Все 10 предметов должны быть одной редкости');
		const inputRarity = entries[0].rarity;
		const tierFrom = SteamAccount.CS2_RARITY_BY_NAME[inputRarity];
		if (tierFrom == null) throw new Error(`Неизвестная редкость "${inputRarity}" в базе`);
		const tierTo = tierFrom + 1;
		if (tierTo > 5) throw new Error('Эта редкость уже максимальная (Covert) — дальше крафтить нельзя');
		const rarityTo = Object.keys(SteamAccount.CS2_RARITY_BY_NAME).find(k => SteamAccount.CS2_RARITY_BY_NAME[k] === tierTo);
		const qualityLabel = SteamAccount.CS2_RARITY_NAMES[tierTo];

		const inputCounts = {};
		for (const e of entries) for (const c of e.collections) inputCounts[c] = (inputCounts[c] || 0) + 1;
		const colls = Object.keys(inputCounts);

		const poolByColl = {};
		for (const c of colls) {
			poolByColl[c] = Object.values(db.skins).filter(s => s.rarity === rarityTo && (s.collections || []).includes(c));
		}

		const cands = {};
		for (const c of colls) {
			const pool = poolByColl[c];
			if (!pool.length) continue;
			const weightC = inputCounts[c] / entries.length;
			const perItem = weightC / pool.length;
			const collName = (db.sets[c] && db.sets[c].name) || c;
			for (const s of pool) {
				const k = s.weapon + '|' + s.paint;
				let cand = cands[k];
				if (!cand) {
					const isKnife = /^weapon_knife/.test(s.weapon_schema);
					const base = (isKnife ? '★ ' : '') + s.weapon + ' | ' + s.paint;
					cand = {
						name: base,
						priceName: base + ' (Factory New)',
						weapon: s.weapon, paint: s.paint, rarity: tierTo, qualityLabel,
						floatMin: s.floatMin, floatMax: s.floatMax,
						collections: new Set(), percent: 0
					};
					cands[k] = cand;
				}
				// Запоминаем базовое имя, чтобы позже (после расчёта экстерьера)
				// выставить priceName с реальным износом выхода.
				cand.baseName = cand.name;
				cand.percent += perItem;
				cand.collections.add(collName);
			}
		}

		const candidates = Object.values(cands)
			.map(c => ({ name: c.name, priceName: c.priceName, weapon: c.weapon, paint: c.paint, rarity: c.rarity, qualityLabel: c.qualityLabel, floatMin: c.floatMin, floatMax: c.floatMax, collections: [...c.collections], percent: +(c.percent * 100).toFixed(2) }))
			.sort((a, b) => b.percent - a.percent);

		// Сводка по коллекциям: шанс, что выход придёт именно из этой коллекции
		// равен доле входных предметов, взятых из неё (механика Trade-Up CS2).
		const collections = colls.map(c => ({
			name: (db.sets[c] && db.sets[c].name) || c,
			chance: +((inputCounts[c] / entries.length) * 100).toFixed(2)
		})).sort((a, b) => b.chance - a.chance);

		// Распределение выхода по ЭКСТЕРЬЕРУ (качеству) на основе float входов.
		// Механика CS2: нормализуем float каждого входа в его диапазоне скина,
		// усредняем, затем проецируем на диапазон каждого выходного скина.
		let qualityChances = null;
		let qualityNote = null;
		if (inputNorms.length) {
			const avgNorm = inputNorms.reduce((a, b) => a + b, 0) / inputNorms.length;
			for (const c of candidates) {
				const omin = (c.floatMin != null ? c.floatMin : 0);
				const omax = (c.floatMax != null ? c.floatMax : 1);
				const outFloat = omin + avgNorm * (omax - omin);
				const ex = SteamAccount.cs2ExteriorFor(outFloat);
				c.exterior = ex.label;
				c.exteriorShort = ex.short;
				c.outFloat = +outFloat.toFixed(4);
				// Цену берём под реальный износ выхода (для обрезанных скинов
				// FN-листинга на рынке нет — иначе цена была бы пустой).
				c.priceName = (c.baseName || c.name) + ' (' + ex.label + ')';
			}
			const qmap = {};
			for (const c of candidates) qmap[c.exterior] = (qmap[c.exterior] || 0) + c.percent;
			qualityChances = SteamAccount.CS2_WEAR.map(w => ({
				label: w.label, short: w.short,
				pct: +(qmap[w.label] || 0).toFixed(2)
			}));
			qualityNote = `Средний нормализованный float входов: ${avgNorm.toFixed(3)} (по ${inputNorms.length} из ${entries.length} предметов с известным float)`;
		} else {
			qualityNote = 'Нет данных о float входных предметов — распределение по качеству недоступно.';
		}

		return { candidates, collections, qualityChances, qualityNote };
	}

	// Останавливает «игру» в CS2 после закрытия окна контрактов:
	// возвращает прежнее состояние «Играть» (если оно было) или гасит play-клиент.
	async stopCs2() {
		if (this.playClient && (this.playClient.steamID || this.playClient._loggedOn)) {
			if (this._cs2HadPlayBefore) {
				try { this.playClient.gamesPlayed(this.playAppIds); } catch (e) { /* ignore */ }
				this.playStatus = {
					state: this.playAppIds.length ? 'playing' : 'stopped',
					games: this.playAppIds,
					label: this.playAppIds.length ? `Играет: ${this.playAppIds.join(', ')}` : 'Не играет'
				};
				this._emitPlayStatus();
			} else {
				await this.stopPlay();
			}
		}
		this._cs2HadPlayBefore = null;
		// Полный сброс transient-состояния GC: при повторном открытии окна
		// гарантированно проходим путь gamesPlayed(730) -> appLaunched -> connect
		// заново, без «зависания» на старом ожидателе или ложно живой сессии.
		this.cs2Cell = null;
		if (this.cs2) {
			this.cs2.haveGCSession = false;
			this.cs2._isInCSGO = false;
		}
		return this.statusPayload();
	}

	// Выполняет Trade-Up контракт: собирает 10 assetid в рецепт и запускает крафт на GC.
	async cs2Craft(assetIds) {
		await this._ensureCs2Client();
		const ids = Array.from(new Set((assetIds || []).map(String).filter(Boolean)));
		if (ids.length !== 10) throw new Error('Контракт требует ровно 10 предметов одной редкости');

		const inv = await this.cs2GetInventory();
		const selected = inv.filter(i => ids.includes(i.assetid));
		if (selected.length !== 10) throw new Error('Часть выбранных предметов не найдена в инвентаре');

		const rarities = new Set(selected.map(i => i.rarity));
		const statTraks = new Set(selected.map(i => i.statTrak));
		if (rarities.size !== 1) throw new Error('Все 10 предметов должны быть одной редкости');
		if (statTraks.size !== 1) throw new Error('Нельзя смешивать StatTrak и обычные предметы в одном контракте');

		const recipe = selected[0].recipe;
		if (recipe < 0) throw new Error('Для выбранной редкости контракт невозможен (Covert/souvenir)');

		// Цены на входные предметы больше не парсим (отключено по запросу).
		const input = selected.map(i => {
			return { name: i.marketName, price: null, amount: i.amount || 1 };
		});
		const totalInput = null;
		const beforeIds = new Set(inv.map(i => i.assetid));

		this.log.info(this.accountName, `Контракт Trade-Up: ${selected.length} предметов, рецепт ${recipe}`);

		return new Promise((resolve, reject) => {
			let done = false;
			const finish = (fn, v) => { if (done) return; done = true; clearTimeout(t); fn(v); };
			const t = setTimeout(() => finish(reject, new Error('Таймаут выполнения контракта (30с)')), 30000);
			this.cs2.once('craftingComplete', async (recipeGot) => {
				if (recipeGot === -1) {
					this.log.error(this.accountName, 'Steam отклонил контракт (неверный набор предметов)');
					return finish(reject, new Error('Steam отклонил контракт — проверьте, что все предметы одной редкости и из подходящих коллекций'));
				}
				this.log.success(this.accountName, `Контракт выполнен (рецепт ${recipeGot})`);
				const gained = await this._detectGainedItems(beforeIds);
				this._appendHistory({
					ts: new Date().toISOString(),
					recipe: recipeGot,
					totalInput,
					input: input.map(x => ({ name: x.name, price: x.price })),
					gained
				});
				finish(resolve, { recipe: recipeGot, itemsGained: gained.map(g => g.name) });
			});
			try {
				this.cs2.craft(ids, recipe);
			} catch (e) {
				finish(reject, e);
			}
		});
	}

	// Пытается найти предмет(ы), появившиеся после крафта, сравнивая assetid до/после.
	async _detectGainedItems(beforeIds) {
		for (let attempt = 0; attempt < 4; attempt++) {
			await new Promise(r => setTimeout(r, 1200));
			try {
				const after = await this.cs2GetInventory();
				const gained = after.filter(i => !beforeIds.has(i.assetid));
				if (gained.length) return gained.map(i => ({ assetid: i.assetid, name: i.marketName }));
			} catch (e) { /* retry */ }
		}
		return [];
	}

	// ─── История контрактов (per-account, файл cs2-history.json) ─────────
	_histFile() { return path.join(APP_DATA, 'cs2-history.json'); }
	_loadHistory() {
		try { return JSON.parse(fs.readFileSync(this._histFile(), 'utf8')) || {}; }
		catch (e) { return {}; }
	}
	_saveHistory(map) {
		try {
			fs.mkdirSync(APP_DATA, { recursive: true });
			fs.writeFileSync(this._histFile(), JSON.stringify(map, null, 2));
		} catch (e) { /* ignore */ }
	}
	_appendHistory(entry) {
		const map = this._loadHistory();
		const arr = map[this.accountName] || [];
		arr.unshift(entry);
		map[this.accountName] = arr.slice(0, 200);
		this._saveHistory(map);
	}
	cs2GetHistory() {
		return this._loadHistory()[this.accountName] || [];
	}

	// Пытается залогинить steam-user клиент. Приоритет: сохранённый SteamClient refresh-токен,
	// затем — получаем свежий через LoginSession(SteamClient) с обычным паролем+2FA и
	// авто-подтверждением входа на устройстве. SteamClient токен имеет aud=client, в отличие от
	// нашего MobileApp refresh-токена (aud=mobile), так что его нельзя просто передать.
	async _logonPlayClient(client) {
		const token = this.record.steamClientRefreshToken;
		if (token) {
			client.logOn({ refreshToken: token });
			return;
		}
		const fresh = await this._obtainSteamClientRefreshToken();
		if (!fresh) throw new Error('Не удалось создать SteamClient refresh-токен');
		this.record.steamClientRefreshToken = fresh;
		this._save();
		client.logOn({ refreshToken: fresh });
	}

	// Создаёт refresh-токен для платформы SteamClient (aud=client). Логинимся паролем + 2FA из
	// shared_secret; если Steam требует подтверждения входа — делаем это через тот же flow, что
	// и подтверждение входа в SDA (GetAuthSessionsForAccount + UpdateAuthSessionWithMobileConfirmation).
	async _obtainSteamClientRefreshToken() {
		if (!this.record.password) {
			throw new Error('Для «игры» нужен сохранённый пароль — включите «запомнить пароль» при входе');
		}
		const session = new LoginSession(EAuthTokenPlatformType.SteamClient, this._proxySteamOpts());
		const code = this.record.sharedSecret ? SteamTotp.generateAuthCode(this.record.sharedSecret) : undefined;

		let result;
		try {
			result = await session.startWithCredentials({
				accountName: this.accountName,
				password: this.record.password,
				steamGuardCode: code
			});
		} catch (err) {
			throw new Error(`Не удалось начать вход SteamClient: ${err.message || err}`);
		}

		if (result && result.actionRequired) {
			const guardTypes = result.validActions || [];
			const needsDeviceConfirm = guardTypes.some(a => a.type === EAuthSessionGuardType.DeviceConfirmation);
			const needsEmailCode = guardTypes.some(a => a.type === EAuthSessionGuardType.EmailCode);
			if (needsDeviceConfirm) {
				this.log.info(this.accountName, 'Ожидаем подтверждение входа SteamClient…');
				await this._approvePendingLoginForSelf();
			}
			if (needsEmailCode) {
				throw new Error('Steam требует код из email — введите его вручную через steamcommunity.com');
			}
		}

		await new Promise((resolve, reject) => {
			let settled = false;
			const fail = (err) => { if (!settled) { settled = true; reject(err); } };
			session.once('authenticated', () => { if (!settled) { settled = true; resolve(); } });
			session.once('error', (err) => fail(err || new Error('Ошибка аутентификации SteamClient')));
			setTimeout(() => fail(new Error('Таймаут ожидания аутентификации SteamClient (90с)')), 90000);
		});

		const token = session.refreshToken;
		if (!token) throw new Error('SteamClient refresh-токен не выдан');
		this.log.success(this.accountName, 'Получен SteamClient refresh-токен (aud=client)');
		return token;
	}

	// Опрашивает pending-логины своего аккаунта через MobileApp токен и подтверждает вход,
	// созданный в _obtainSteamClientRefreshToken (device confirmation) — тот же механизм,
	// что и кнопка «Подтвердить вход» в SDA.
	async _approvePendingLoginForSelf(timeoutMs = 45000) {
		const token = await this._resolveMobileAccessToken();
		const steamId = steamAuthWebapi.decodeJwt(token).sub;
		const deadline = Date.now() + timeoutMs;
		await new Promise(r => setTimeout(r, 1500));
		while (Date.now() < deadline) {
			let clientIds = [];
			try { clientIds = await steamAuthWebapi.listAuthSessions(token); } catch (e) { /* retry */ }
			let approved = 0;
			for (const clientId of clientIds) {
				try {
					const info = await steamAuthWebapi.getAuthSessionInfo(token, clientId);
					const version = (typeof info.version === 'number' && info.version !== 0) ? info.version : 1;
					await steamAuthWebapi.updateAuthSessionWithMobileConfirmation(token, this.record.sharedSecret, {
						clientId,
						version,
						steamId,
						approve: true
					});
					approved++;
				} catch (e) { /* сессия могла уже исчезнуть — игнорируем */ }
			}
			if (approved > 0) return true;
			await new Promise(r => setTimeout(r, 2500));
		}
		return false;
	}



	// ─── Trade offers ─────────────────────────────────────────────────────

	_shouldAutoAccept(offer) {
		if (!offer || offer.isOurOffer) return false;

		// Auto-accept "gift" trades only: the sender gives items but requests nothing
		// in return. If we are expected to give anything away, require manual review.
		const weGive = (offer.itemsToGive || []);
		if (weGive.length > 0) return false;

		return true;
	}

	async _refreshOffers() {
		if (!this.connected || !this.manager) return;
		if (this._offersRefreshing) return; // don't overlap requests
		this._offersRefreshing = true;
		try {
			const filter = TradeOfferManager.EOfferFilter.All;
			const res = await new Promise((resolve, reject) => {
				this.manager.getOffers(filter, null, (err, sent, received) => {
					if (err) return reject(err);
					resolve({ sent: sent || [], received: received || [] });
				});
			});

			this.sentOffers = res.sent.map(o => this._offerPayload(o, true));
			this.receivedOffers = res.received.map(o => this._offerPayload(o, false));

			this.events.emit('account:offers', { account: this.accountName, sent: this.sentOffers, received: this.receivedOffers });
		} catch (err) {
			if (err.message !== 'Not Logged In') {
				this.log.warn(this.accountName, `Загрузка трейдов: ${err.message}`);
			}
		} finally {
			this._offersRefreshing = false;
		}
	}

	_offerPayload(offer, outgoing) {
		const give = (offer.itemsToGive || []).map(SteamAccount._itemDetail);
		const receive = (offer.itemsToReceive || []).map(SteamAccount._itemDetail);
		const items = outgoing ? (offer.itemsToGive || []) : (offer.itemsToReceive || []);
		const itemsLabel = items.map(i => i.market_name || i.name || `${i.appid}:${i.assetid || ''}`).join(', ');
		return {
			id: offer.id,
			partner: offer.partner ? offer.partner.toString() : null,
			state: offer.state,
			stateLabel: tradeOfferStateName(offer.state),
			message: offer.message || '',
			created: offer.created ? new Date(offer.created.getTime()).toISOString() : null,
			expires: offer.expires ? new Date(offer.expires.getTime()).toISOString() : null,
			isOurOffer: !!offer.isOurOffer,
			items: itemsLabel,
			giveItems: give,
			receiveItems: receive,
			confirmationMethod: offer.confirmationMethod !== undefined ? offer.confirmationMethod : null
		};
	}

	// Подробности предмета из предложения обмена (иконка, качество, редкость) для
	// отдельного окна просмотра трейда.
	static _itemDetail(i) {
		const tags = Array.isArray(i.tags) ? i.tags : [];
		const exteriorTag = tags.find(t => t.category === 'Exterior');
		const rarityTag = tags.find(t => t.category === 'Rarity');
		let exteriorShort = null;
		if (exteriorTag && exteriorTag.name) {
			const m = exteriorTag.name.match(/\(([^)]+)\)/);
			exteriorShort = m ? m[1] : exteriorTag.name;
		}
		return {
			name: i.market_name || i.name || 'Предмет',
			marketHashName: i.market_hash_name || null,
			icon: i.icon_url ? i.getImageURL() : null,
			iconLarge: i.icon_url ? i.getLargeImageURL() : null,
			amount: i.amount || 1,
			appid: i.appid,
			exterior: exteriorTag ? exteriorTag.name : null,
			exteriorShort,
			rarity: rarityTag ? rarityTag.name : null,
			type: i.type || null
		};
	}

	acceptOffer(offerId) {
		return new Promise((resolve, reject) => {
			this.manager.getOffer(offerId, (err, offer) => {
				if (err) return reject(err);
				offer.accept((err, status) => {
					if (err) return reject(err);
					this.log.success(this.accountName, `Трейд #${offerId} принят`);
					this._confirmOfferIfNeeded(offer);
					this._refreshOffers();
					// Подтверждение (mobile confirmation) появляется в Steam с задержкой —
					// опросим чуть позже, чтобы бейдж уведомления отобразился сразу.
					setTimeout(() => this._pollConfirmations().catch(() => {}), 5000);
					resolve(status);
				});
			});
		});
	}

	declineOffer(offerId) {
		return new Promise((resolve, reject) => {
			this.manager.getOffer(offerId, (err, offer) => {
				if (err) return reject(err);
			offer.decline((err, status) => {
				if (err) return reject(err);
				this.log.info(this.accountName, `Трейд #${offerId} отклонён`);
				this._refreshOffers();
				resolve(status);
			});
			});
		});
	}

	// If accepting the offer created a mobile confirmation, auto-accept it too
	_confirmOfferIfNeeded(offer) {
		if (!this.record.identitySecret) return;
		if (!this.confirmEnabled) return;
		if (offer.confirmationMethod !== undefined && offer.confirmationMethod !== 0) {
			// EConfirmationMethod: None=0
			setTimeout(() => {
				this.acceptAllConfirmations().catch(err => {
					this.log.warn(this.accountName, `Автоподтверждение трейда: ${err.message}`);
				});
			}, 3000);
		}
	}

	// ─── Inventory & mass sending ─────────────────────────────────────────

	// Re-fetch fresh web cookies using our saved refresh token and re-attach them to
	// SteamCommunity + TradeOfferManager. This avoids Steam rejections of actions
	// (like sending trade offers -> error 15) due to a stale/expired sessionid.
	async _refreshWebSession() {
		if (!this.session && this.record.refreshToken) {
			const session = new LoginSession(EAuthTokenPlatformType.MobileApp, this._proxySteamOpts());
			session.refreshToken = this.record.refreshToken;
			this.session = session;
		}
		if (!this.session || !this.session.refreshToken) return;

		try {
			const cookies = await this.session.getWebCookies();
			if (this.community && this.community.setCookies) this.community.setCookies(cookies);
			if (this.manager && this.manager.setCookies) {
				await new Promise((resolve, reject) => {
					this.manager.setCookies(cookies, err => err ? reject(err) : resolve());
				});
			}
			if (this.record.refreshToken !== this.session.refreshToken) {
				this.record.refreshToken = this.session.refreshToken;
				this._save();
			}
			this.log.info(this.accountName, 'Сессия обновлена перед отправкой');
		} catch (err) {
			this.log.warn(this.accountName, `Не удалось обновить сессию: ${err.message}`);
		}
	}

	async getInventory(appId, contextId) {
		if (!this.manager) throw new Error('Аккаунт не подключён');
		return new Promise((resolve, reject) => {
			this.manager.getInventoryContents(appId, contextId, false, (err, items) => {
				if (err) return reject(err);
				resolve(items.map(i => {
					return {
						appid: i.appid,
						contextid: i.contextid,
						assetid: i.assetid,
						amount: i.amount,
						marketName: i.market_name || i.name || `${i.appid}:${i.assetid}`,
						// Steam's `tradable` flag is per-item and already reflects the current
						// state (trade hold/bans included). market_tradable_restriction is a
						// static class-level value (7 for all CS2 items) and must NOT be used
						// to compute tradability, otherwise every item looks like it's on hold.
						tradable: i.tradable !== false,
						tradeHoldDays: 0,
						marketable: i.marketable !== false,
						icon: i.icon_url ? i.getImageURL() : null,
						iconLarge: i.icon_url ? i.getLargeImageURL() : null,
						rarity: i.rarity || null,
						tags: (i.tags || []).slice(0, 4).map(t => t.name).filter(Boolean)
					};
				}));
			});
		});
	}

	async massSend(targetSteamID, { appId, contextId, maxItems = 60, delayMs = 4000, onlyTradable = true, assetIds = null, tradeToken = null } = {}, progress) {
		if (!this.manager || !this.connected) throw new Error('Аккаунт не подключён');
		const SteamID = require('steamid');
		let target;
		let token = tradeToken || null;

		// Accept a full trade URL: partner=...&token=...
		if (typeof targetSteamID === 'string' && /^https?:\/\//.test(targetSteamID) && /tradeoffer/i.test(targetSteamID)) {
			const u = new URL(targetSteamID);
			const partner = Number(u.searchParams.get('partner'));
			token = u.searchParams.get('token') || token;
			target = partner ? SteamID.fromIndividualAccountID(partner) : null;
		} else {
			target = new SteamID(targetSteamID);
		}

		if (!target || !target.isValid() || target.type !== SteamID.Type.INDIVIDUAL) throw new Error('Неверный SteamID получателя');

		if (!token) {
			this.log.warn(this.accountName, `Получатель ${target.getSteamID64()} указан БЕЗ торгового токена. Если он не в друзьях, Steam отклонит отправку (15).`);
		} else {
			this.log.info(this.accountName, `Торговый токен получен (${token.length} симв.) — отправка возможна вне списка друзей`);
		}

		const items = await new Promise((resolve, reject) => {
			this.manager.getInventoryContents(appId, contextId, false, (err, items) => {
				if (err) return reject(err);
				resolve(items.filter(i => {
					if (!onlyTradable) return true;
					return i.tradable !== false;
				}));
			});
		});

		// If specific asset ids were chosen, keep only those
		let selected = items;
		if (assetIds && assetIds.length) {
			const set = new Set(assetIds.map(String));
			selected = items.filter(i => set.has(String(i.assetid)));
		}

		if (!selected.length) {
			progress && progress(0, 0, []);
			return { total: 0, sent: 0, skipped: items.length };
		}

		return new Promise((resolve, reject) => {
			let sent = 0;
			const total = selected.length;

			// helper: send a batch of items
			const sendBatch = async (batch, batchIndex) => {
				try {
					if (!this.connected) throw new Error('Аккаунт отключён');
					// Refresh the web session before each batch so Steam doesn't reject the send
					// with (15) AccessDenied because of a stale/expired sessionid.
					await this._refreshWebSession();
					const offer = this.manager.createOffer(target, token || undefined);
					offer.addMyItems(batch);
					await new Promise((resolve2, reject2) => {
						offer.send((err) => {
							if (err) return reject2(err);
							resolve2();
						});
					});
					sent += batch.length;
					this.log.success(this.accountName, `Отправлено #${sent}/${total} (трейд ${offer.id})`);
					progress && progress(sent, total, [{ offerId: offer.id, items: batch.length }]);
					this._confirmOfferIfNeeded({ confirmationMethod: 2 });

					if (sent < total) {
						setTimeout(() => sendBatch(selected.slice(sent, sent + maxItems), batchIndex + 1), delayMs);
					} else {
						resolve({ total, sent });
					}
				} catch (err) {
					// Surface the real Steam message (e.g. "There was an error sending your trade offer. Please try again later. (15)")
					let detail = err.message || String(err);
					const cause = err.cause ? ` (причина: ${err.cause})` : '';
					const offered = `Отправка трейда прервана на ${sent}/${total}`;
					if (err.cause === 'NewDevice') {
						// Steam считает текущее устройство/сессию новым и временно блокирует отправку.
						detail = `${offered}: Steam считает вход с этого устройства новым (NewDevice) и временно ограничил торговлю. Подождите некоторое время или войдите через подтверждённый Steam Guard. Детали: ${detail}${cause}`;
					} else if (/access denied|not friends|invalid.*token|tradeoffer.*token|\(\s*15\s*\)/i.test(detail)) {
						// Token присутствует, но Steam всё равно отклонил (15): вариант — токен неверный / устаревший,
						// либо аккаунт получателя «ограниченный» (новый, торговля не активирована).
						if (token) {
							detail = `${offered}: Steam отклонил (15), несмотря на переданный токен. Возможные причины: 1) торговый токен неверный или устаревший (токены обновляются при изменении настроек обмена на steamcommunity.com/logged_out/tradeoffers или при изменении пароля) — пересоздайте трейд-ссылку и вставьте новый токен; 2) аккаунт получателя ограничен: у нового аккаунта, не потратившего $5 в Steam или без покупок, торговля не активирована и он не может принимать трейды — активируйте его. Получатель: ${target.getSteamID64()}. Детали: ${detail}${cause}`;
						} else {
							detail = `${offered}: Steam отклонил (AccessDenied). Проверьте: получатель в друзьях ИЛИ корректный торговый токен из его трейд-ссылки. Детали: ${detail}${cause}`;
						}
					} else if (/too many|rate limit|\(\s*84\s*\)/i.test(detail)) {
						detail = `${offered}: слишком много трейдов за короткое время (rate limit). Увеличьте паузу между трейдами. Детали: ${detail}${cause}`;
					} else {
						detail = `${offered}: ${detail}${cause}`;
					}
					this.log.error(this.accountName, detail);
					reject(new Error(detail));
				}
			};

			sendBatch(selected.slice(0, maxItems), 0);
		});
	}

	// ─── Status / helpers ─────────────────────────────────────────────────

	setStatus(state, label) {
		this.status = { state, label };
		this.events.emit('account:status', this.statusPayload());
	}

	statusPayload() {
		return {
			name: this.accountName,
			label: this.record.label || this.accountName,
			steamID64: this.steamID || this.record.steamID64,
			avatar: SteamAccount.normalizeAvatar(this.record.avatar),
			status: this.status || { state: 'offline', label: 'Не в сети' },
			autoConfirm: this.confirmEnabled,
			autoAccept: this.acceptEnabled,
			proxy: this.proxy || null,
			hasSecrets: !!(this.record.sharedSecret && this.record.identitySecret),
			hasRefreshToken: !!this.record.refreshToken,
			play: {
				state: this.playStatus.state,
				label: this.playStatus.label,
				games: this.playStatus.games || this.playAppIds,
				autoPlay: this.autoPlayEnabled,
				appIds: this.playAppIds
			}
		};
	}

	offersPayload() {
		return { account: this.accountName, sent: this.sentOffers, received: this.receivedOffers };
	}

	confirmationsPayload() {
		return { account: this.accountName, confirmations: this.confirmations };
	}

	// Приводит ссылку на аватар к https://avatars.steamstatic.com (рендерер блокирует
	// http-контент, который отдаёт steamcdn-a.akamaihd.net).
	static normalizeAvatar(url) {
		if (!url || typeof url !== 'string') return null;
		const m = url.match(/([0-9a-f]{40})_full\.jpg/i);
		if (m) return `https://avatars.steamstatic.com/${m[1]}_full.jpg`;
		return url.replace(/^http:\/\//i, 'https://');
	}

	_save() {
		this.events.emit('account:save', {
			name: this.accountName,
			steamID64: this.record.steamID64 || null,
			avatar: this.record.avatar || null,
			refreshToken: this.record.refreshToken || null,
			mobileAccessToken: this.record.mobileAccessToken || null,
			password: this.record.password || null,
			lastLogin: this.record.lastLogin || null,
			playGames: this.record.playGames || null,
			autoPlay: this.record.autoPlay || null,
			steamClientRefreshToken: this.record.steamClientRefreshToken || null,
			proxy: this.record.proxy || null
		});
	}
}

function tradeOfferStateName(state) {
	const names = {
		1: 'Не создан',
		2: 'Активен',
		3: 'Принят',
		4: 'Встречное предложение',
		5: 'Истёк',
		6: 'Отменён',
		7: 'Отклонён',
		8: 'Недействительные предметы',
		9: 'Требует подтверждения',
		10: 'Отменён отправителем',
		11: 'В ожидании (эскроу)'
	};
	return names[state] || `State ${state}`;
}

module.exports = { SteamAccount, MAPPEvents };