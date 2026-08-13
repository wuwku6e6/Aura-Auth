import React, { useEffect, useState } from 'react';
import { useI18n, tradeOfferStateName } from '../i18n.jsx';

const PLAY_PRESETS = [
	{ appid: 730, label: 'CS 2' },
	{ appid: 570, label: 'Dota 2' },
	{ appid: 440, label: 'TF2' },
	{ appid: 252490, label: 'Rust' }
];

export default function AccountCard({
	account,
	offers,
	confirmations,
	onLogin,
	onStatus,
	onAutoConfirm,
	onAutoAccept,
	onAcceptOffer,
	onDeclineOffer,
	onAcceptAllConfirms,
	onRespondConf,
	onPlay,
	onStopPlay,
	onAutoPlay,
	onRename,
	onRemove,
	onLogout
}) {
	const { t } = useI18n();
	const [pwd, setPwd] = useState('');
	const [rememberPwd, setRememberPwd] = useState(false);
	const [busy, setBusy] = useState(false);
	const [tab, setTab] = useState('trades');
	const [approvingLogin, setApprovingLogin] = useState(false);
	const [loginNotice, setLoginNotice] = useState('');
	const [guard, setGuard] = useState(null);
	const [copied, setCopied] = useState(false);
	const [playInput, setPlayInput] = useState('');
	const [myPlayApps, setMyPlayApps] = useState([]); // выбранные appID (управляются пользователем)
	const [playBusy, setPlayBusy] = useState(false);
	const [playOpen, setPlayOpen] = useState(false);
	const [editingName, setEditingName] = useState(false);
	const [nameDraft, setNameDraft] = useState('');

	const statusState = account.status?.state || 'offline';
	const statusLabel = account.status?.state === 'online' ? t('Онлайн') : t('Не в сети');
	const play = account.play || { state: 'stopped', label: t('Не играет'), games: [], autoPlay: false, appIds: [] };
	const isPlaying = play.state === 'playing';

	const appName = (appid) => {
		const p = PLAY_PRESETS.find(g => g.appid === Number(appid));
		return p ? p.label : String(appid);
	};
	const playLabel = isPlaying && play.games && play.games.length
		? t('Играет: {games}', { games: play.games.map(g => appName(g)).join(', ') })
		: t('Играет');
	const playStateLabel = isPlaying ? t('Играет') : t('Не играет');
	const displayStatus = isPlaying ? playLabel : statusLabel;
	const displayState = isPlaying ? 'playing' : statusState;

	const toggleApp = (appid) => {
		setMyPlayApps(prev => prev.includes(appid) ? prev.filter(a => a !== appid) : [...prev, appid]);
	};
	const addCustom = () => {
		const parts = playInput.split(',').map(s => s.trim()).filter(Boolean).map(Number).filter(n => n > 0 && Number.isFinite(n));
		if (parts.length) setMyPlayApps(prev => Array.from(new Set([...prev, ...parts])));
		setPlayInput('');
	};
	const handlePlay = async () => {
		const apps = (myPlayApps && myPlayApps.length) ? myPlayApps : (play.appIds || []);
		if (!apps.length) { alert(t('Выберите игры')); return; }
		setMyPlayApps(apps);
		setPlayBusy(true);
		try {
			const r = await onPlay(account.name, apps);
			if (r && r.ok === false) alert(r.error || t('Не удалось запустить «игру»'));
		} catch (e) { alert(e?.message || t('Ошибка запуска')); }
		finally { setPlayBusy(false); }
	};
	const handleStop = async () => {
		setPlayBusy(true);
		try {
			const r = await onStopPlay(account.name);
			if (r && r.ok === false) alert(r.error || t('Не удалось остановить'));
		} catch (e) { alert(e?.message || t('Ошибка остановки')); }
		finally { setPlayBusy(false); }
	};
	const handleAutoPlayToggle = async (e) => {
		const checked = e.target.checked;
		if (checked && (!myPlayApps || !myPlayApps.length)) {
			alert(t('Сначала выберите игры для автоигры'));
			return;
		}
		const r = await onAutoPlay(account.name, checked);
		if (r && r.ok === false) alert(r.error || t('Ошибка'));
	};

	useEffect(() => {
		// Синхронизируем выбранные игры при смене аккаунта
		setMyPlayApps((play.appIds && play.appIds.length) ? play.appIds : []);
		setPlayOpen(false);
	}, [account.name]);
	useEffect(() => {
		if (statusState === 'online') {
			window.aura.getOffers(account.name).catch(() => {});
			window.aura.getConfirmations(account.name).catch(() => {});
			if (account.hasSecrets) {
				let alive = true;
				const tick = async () => {
					if (!alive) return;
					try {
						const res = await window.aura.getGuardCode(account.name);
						if (res && res.ok && res.data) setGuard(res.data);
						else setGuard(null);
					} catch (e) { setGuard(null); }
				};
				tick();
				const t = setInterval(tick, 1000);
				return () => { alive = false; clearInterval(t); };
			}
		} else {
			setGuard(null);
		}
	}, [statusState, account.name, account.hasSecrets]);

	const copyCode = () => {
		if (!guard) return;
		navigator.clipboard.writeText(guard.code).then(() => {
			setCopied(true);
			setTimeout(() => setCopied(false), 1200);
		}).catch(() => {});
	};

	const handleLogin = async () => {
		setBusy(true);
		try {
			const res = await window.aura.login(account.name, pwd, rememberPwd);
			if (res && res.ok === false && res.error) {
				alert(res.error);
			} else if (res && res.ok && res.data) {
				const st = res.data;
				if (onStatus) onStatus(st);
			}
		} finally {
			setBusy(false);
		}
	};

	const startRename = () => {
		setNameDraft(account.label || account.name);
		setEditingName(true);
	};
	const commitRename = async () => {
		const label = nameDraft.trim();
		if (!label) { setEditingName(false); return; }
		setEditingName(false);
		if (label === (account.label || account.name)) return;
		const r = await onRename(label);
		if (r && r.ok === false) alert(r.error || t('Не удалось переименовать'));
	};
	const cancelRename = () => setEditingName(false);

	const sent = (offers?.sent || []).sort((a, b) => (b.created || '').localeCompare(a.created || ''));
	const received = (offers?.received || []).sort((a, b) => (b.created || '').localeCompare(a.created || ''));
	const confs = confirmations || [];

	const handleApproveLogin = async () => {
		setApprovingLogin(true);
		setLoginNotice('');
		try {
			// Как в мобильном приложении: опрашиваем Steam, какие входы ждут подтверждения,
			// и подтверждаем их одной кнопкой — без QR и ссылок.
			const res = await window.aura.listPendingLogins();
			if (res && res.ok === false) {
				alert(res.error || t('Ошибка проверки входа'));
				return;
			}
			const pending = (res?.data || []).filter(p => p.account === account.name);
			if (pending.length === 0) {
				setLoginNotice(t('Нет ожидающих входов'));
				setTimeout(() => setLoginNotice(''), 4000);
				return;
			}
			let approved = 0;
			for (const p of pending) {
				const r = await window.aura.respondLogin(p.account, p.clientId, p.version, true);
				if (r && r.ok) approved++;
			}
			setLoginNotice(t('Вход подтверждён') + (approved > 1 ? ` (${approved})` : ''));
			setTimeout(() => setLoginNotice(''), 4000);
			window.aura.getConfirmations(account.name).catch(() => {});
		} finally {
			setApprovingLogin(false);
		}
	};

	return (
		<div className="card-wrap">
			<header className="card-header">
				<div className="header-left">
					<div className={`avatar ${statusState}`}>{(account.label || account.name)?.charAt(0).toUpperCase()}</div>
					<div className="header-title-wrap">
						{editingName ? (
							<input
								className="input rename-input"
								value={nameDraft}
								autoFocus
								onChange={e => setNameDraft(e.target.value)}
								onKeyDown={e => {
									if (e.key === 'Enter') commitRename();
									if (e.key === 'Escape') cancelRename();
								}}
								onBlur={commitRename}
							/>
						) : (
							<h1 className="account-title" title={account.name}>
								{account.label || account.name}
								<button type="button" className="rename-btn" onClick={startRename} title={t('Переименовать')}>✎</button>
							</h1>
						)}
						<div className="account-meta">
							<span className={`status-badge ${displayState}`}>{displayStatus}</span>
							{account.steamID64 && <span className="meta-id">ID: {account.steamID64}</span>}
							{account.hasSecrets && <span className="meta-chip">2FA ✓</span>}
						</div>
					</div>
				</div>
				<div className="header-actions">
{statusState === 'online' ? (
					<>
						{guard && (
							<button className="guard-code" onClick={copyCode} title={t('Код Steam Guard, обновится через {n}с. Нажмите, чтобы скопировать', { n: guard.remaining })}>
								<div className="guard-label">{copied ? t('Скопировано ✓') : t('Код входа')}</div>
								<div className="guard-value-row">
									<span className="guard-value">{guard.code}</span>
									<span className={`guard-timer ${guard.remaining <= 8 ? 'urgent' : ''}`}>{guard.remaining}</span>
								</div>
							</button>
						)}
						{loginNotice && <span className="login-notice">{loginNotice}</span>}
						<button className="btn ghost" disabled={approvingLogin} onClick={handleApproveLogin}>
							{approvingLogin ? t('Проверка…') : t('Подтвердить вход')}
						</button>
						<button className="btn ghost" onClick={onLogout}>{t('Выйти')}</button>
						<a
							className="avatar-mini"
							href={`https://steamcommunity.com/profiles/${account.steamID64 || ''}`}
							target="_blank"
							rel="noopener noreferrer"
							title={t('Открыть профиль Steam ({id})', { id: account.steamID64 })}
						>
							{account.avatar ? <img src={account.avatar} alt={t('аватар')} className="avatar-mini-img" /> : <span className="avatar-mini-fallback">Steam</span>}
						</a>
					</>
				) : (
						<div className="login-box">
							<input
								type="password"
								className="input"
								placeholder={t('Пароль')}
								value={pwd}
								onChange={e => setPwd(e.target.value)}
								onKeyDown={e => e.key === 'Enter' && handleLogin()}
							/>
							<label className="checkbox">
								<input type="checkbox" checked={rememberPwd} onChange={e => setRememberPwd(e.target.checked)} />
								<span>{t('запомнить пароль (автовход)')}</span>
							</label>
							<button className="btn primary" disabled={busy || !pwd} onClick={handleLogin}>
								{busy ? t('Вход…') : t('Войти')}
							</button>
						</div>
					)}
				</div>
			</header>

			<div className="toggles">
				<label className={`toggle ${account.autoConfirm ? 'on' : ''}`}>
					<input
						type="checkbox"
						checked={!!account.autoConfirm}
						onChange={e => onAutoConfirm(e.target.checked)}
						disabled={statusState !== 'online'}
					/>
					<span className="toggle-track"><span className="toggle-thumb" /></span>
					<span className="toggle-label">
						<strong>{t('Автоподтверждение')}</strong>
						<small>{t('автоматически подтверждать 2FA-подтверждения')}</small>
					</span>
				</label>
				<label className={`toggle ${account.autoAccept ? 'on' : ''}`}>
					<input
						type="checkbox"
						checked={!!account.autoAccept}
						onChange={e => onAutoAccept(e.target.checked)}
						disabled={statusState !== 'online'}
					/>
					<span className="toggle-track"><span className="toggle-thumb" /></span>
					<span className="toggle-label">
						<strong>{t('Автоприём трейдов')}</strong>
						<small>{t('принимать входящие трейды без подтверждения')}</small>
					</span>
				</label>
			</div>

			{statusState === 'online' && (
				<div className="play-section">
					<button type="button" className={`play-header ${playOpen ? 'open' : ''}`} onClick={() => setPlayOpen(o => !o)}>
						<span className="play-title">{t('Играть в игры')}</span>
							<span className={`play-state ${isPlaying ? 'on' : 'off'}`}>{playStateLabel}</span>
						<span className={`play-chevron ${playOpen ? 'open' : ''}`}>▾</span>
					</button>
					{playOpen && (
						<>
							<div className="play-presets">
								{PLAY_PRESETS.map(g => (
									<button
										key={g.appid}
										type="button"
										className={`preset-chip ${myPlayApps.includes(g.appid) ? 'sel' : ''}`}
										onClick={() => toggleApp(g.appid)}
										title={t('Добавить {label} ({appid})', { label: g.label, appid: g.appid })}
									>{g.label}</button>
								))}
							</div>
							<div className="play-custom">
								<input
									value={playInput}
									onChange={e => setPlayInput(e.target.value)}
									placeholder={t('appID через запятую, напр. 730,570,440')}
									disabled={playBusy}
								/>
								<button className="btn small" onClick={addCustom} disabled={playBusy || !playInput.trim()}>+</button>
							</div>
							{myPlayApps.length > 0 && (
								<div className="play-selected">{t('Выбрано: {apps}', { apps: myPlayApps.join(', ') })}</div>
							)}
							<div className="play-actions">
								<label className={`toggle small ${play.autoPlay ? 'on' : ''}`}>
									<input type="checkbox" checked={!!play.autoPlay} onChange={handleAutoPlayToggle} disabled={playBusy} />
									<span className="toggle-track"><span className="toggle-thumb" /></span>
									<span className="toggle-label">{t('Играть при запуске')}</span>
								</label>
								<button className="btn small primary" disabled={playBusy || isPlaying} onClick={handlePlay}>
									{playBusy ? t('Запуск…') : t('Играть')}
								</button>
								<button className="btn small danger-ghost" disabled={playBusy || !isPlaying} onClick={handleStop}>{t('Стоп')}</button>
								<button className="btn small" onClick={() => window.aura.openCs2(account.name)} title={t('Выполнить контракты обмена CS2 без запуска игры')}>
									{t('Контракты CS2')}
								</button>
							</div>
						</>
					)}
				</div>
			)}

			<div className="tabs">
				<button className={`tab ${tab === 'trades' ? 'active' : ''}`} onClick={() => setTab('trades')}>
					{t('Трейды')} {received.length ? <span className="tabs-badge">{received.length}</span> : null}
				</button>
				<button className={`tab ${tab === 'confirms' ? 'active' : ''}`} onClick={() => setTab('confirms')}>
					{t('Подтверждения')} {confs.length ? <span className="tabs-badge warn">{confs.length}</span> : null}
				</button>
				<button className={`tab ${tab === 'confirm-all' ? 'active' : ''}`} onClick={onAcceptAllConfirms}>
					{t('Принять все')}
				</button>
			</div>

			{tab === 'trades' && (
				<div className="offer-list">
					{!offers && <div className="placeholder">{t('Загружаю трейды…')}</div>}
					{offers && received.length === 0 && sent.length === 0 && (
						<div className="placeholder">{t('Активных трейдов нет')}</div>
					)}

					{received.length > 0 && (
						<>
							<div className="group-label">{t('Входящие')}</div>
						{received.map(offer => (
							<OfferRow
								key={offer.id}
								offer={offer}
								incoming
								accountName={account.name}
								onAccept={() => onAcceptOffer(offer.id)}
								onDecline={() => onDeclineOffer(offer.id)}
							/>
						))}
						</>
					)}

					{sent.length > 0 && (
						<>
							<div className="group-label">{t('Исходящие')}</div>
							{sent.map(offer => (
								<OfferRow key={offer.id} offer={offer} />
							))}
						</>
					)}
				</div>
			)}

			{tab === 'confirms' && (
				<div className="offer-list">
					<div className="group-label">{t('Проверяемся каждые 15 секунд. Подтверждения входа одобряются одной кнопкой «Подтвердить вход».')}</div>
					{confs.length === 0 && <div className="placeholder">{t('Нет ожидающих подтверждений')}</div>}
					{confs.map(conf => (
						<div className={`conf-row`} key={conf.id}>
							<div className="conf-info">
								<div className="conf-title">{conf.title}</div>
								{conf.typeLabel && conf.typeLabel !== 'Подтверждение' && <div className="conf-type">{conf.typeLabel}</div>}
								<div className="conf-detail">{conf.receiving || conf.sending || `#${conf.id}`}</div>
							</div>
							<div className="conf-actions">
								<button className="btn small success" onClick={() => onRespondConf({ id: conf.id, key: conf.key, accept: true })}>{t('Подтвердить')}</button>
								<button className="btn small danger" onClick={() => onRespondConf({ id: conf.id, key: conf.key, accept: false })}>{t('Отклонить')}</button>
							</div>
						</div>
					))}
				</div>
			)}
		</div>
	);
}

function OfferRow({ offer, incoming, onAccept, onDecline, accountName }) {
	const { t } = useI18n();
	const isTradeActive = offer.state === 2;
	const open = () => {
		if (incoming && accountName) window.aura.openOffer(accountName, offer);
	};
	return (
		<div className={`offer-row ${offer.state === 2 ? 'active' : ''} ${incoming ? 'clickable' : ''}`}>
			<div className="offer-main" onClick={incoming ? open : undefined}>
				<div className="offer-direction">{incoming ? '⇩' : '⇧'}</div>
				<div className="offer-body">
					<div className="offer-title">{offer.items || t('Пустой трейд')}</div>
					<div className="offer-sub">{t(tradeOfferStateName(offer.state))}{offer.partner ? ` · ${offer.partner}` : ''}</div>
				</div>
				<div className="offer-state">
					<span className={`state-pill ${offer.state === 2 ? 'green' : ''}`}>{t(tradeOfferStateName(offer.state))}</span>
				</div>
			</div>
			{incoming && isTradeActive && (
				<div className="offer-actions">
					<button className="btn small success" onClick={onAccept}>{t('Принять')}</button>
					<button className="btn small danger" onClick={onDecline}>{t('Отклонить')}</button>
				</div>
			)}
		</div>
	);
}