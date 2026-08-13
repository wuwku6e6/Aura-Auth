import React, { useEffect, useMemo, useRef, useState } from 'react';
import AccountCard from './components/AccountCard.jsx';
import MassSendPanel from './components/MassSendPanel.jsx';
import LogPanel from './components/LogPanel.jsx';
import AddAccountModal from './components/AddAccountModal.jsx';
import GuardModal from './components/GuardModal.jsx';
import { useI18n } from './i18n.jsx';

const APP_PRESETS = [
	{ appid: 730, contextid: 2, label: 'CS 2' },
	{ appid: 570, contextid: 2, label: 'Dota 2' },
	{ appid: 440, contextid: 2, label: 'TF2' },
	{ appid: 252490, contextid: 2, label: 'Rust' },
	{ appid: 753, contextid: 6, label: 'Steam (карточки)' }
];

export default function App() {
	const { t } = useI18n();
	const [accounts, setAccounts] = useState([]);
	const [logs, setLogs] = useState([]);
	const [offers, setOffers] = useState({});
	const [confirmations, setConfirmations] = useState({});
	const [massJobs, setMassJobs] = useState({});
	const [guardPrompt, setGuardPrompt] = useState(null);
	const [loginRequests, setLoginRequests] = useState([]); // inline QR-challenge approvals
	const [addModal, setAddModal] = useState(false);
	const [selected, setSelected] = useState(null);
	const [search, setSearch] = useState('');
	const [loading, setLoading] = useState(true);
	const ready = useRef(false);

	const api = window.aura;

	useEffect(() => {
		api.init().then(({ ok, data }) => {
			if (ok) {
				setAccounts(data.accounts || []);
				setLogs(data.logs || []);
				if (data.accounts.length) setSelected(data.accounts[0].name);
			}
			setLoading(false);
		});

		const unsubs = [
			api.on('account:status', payload => {
				setAccounts(prev => {
					const idx = prev.findIndex(a => a.name === payload.name);
					if (idx === -1) return [payload, ...prev];
					const next = [...prev];
					next[idx] = { ...next[idx], ...payload };
					return next;
				});
			}),
			api.on('account:offers', payload => {
				setOffers(prev => ({ ...prev, [payload.account]: payload }));
			}),
			api.on('account:confirmations', payload => {
				setConfirmations(prev => ({ ...prev, [payload.account]: payload.confirmations || [] }));
			}),
			api.on('mass:status', payload => {
				setMassJobs(prev => ({ ...prev, [payload.accountName]: payload }));
			}),
			api.on('guard:request', payload => {
				setGuardPrompt(payload.account);
			}),
			api.on('login:request', payload => {
				// Non-modal one-tap login approval (like the mobile app)
				setLoginRequests(prev => {
					const key = (r) => `${r.account}::${r.clientId}`;
					const dup = prev.findIndex(r => key(r) === key(payload));
					if (dup !== -1) {
						const next = [...prev];
						next[dup] = payload;
						return next;
					}
					return [...prev, payload];
				});
			}),
			api.on('log:update', entries => setLogs(entries))
		];
		return () => unsubs.forEach(u => u());
	}, []);

	const sorted = useMemo(() => {
		return [...accounts].sort((a, b) => (a.label || a.name).localeCompare(b.label || b.name, 'ru'));
	}, [accounts]);

	const filtered = useMemo(() => {
		if (!search) return sorted;
		const q = search.toLowerCase();
		return sorted.filter(a =>
			(a.label || a.name).toLowerCase().includes(q) ||
			a.name.toLowerCase().includes(q) ||
			(a.steamID64 || '').includes(q)
		);
	}, [sorted, search]);

	const [logCollapsed, setLogCollapsed] = useState(true);
	const logRef = useRef(null);
	const scrollToBottom = () => {
		requestAnimationFrame(() => logRef.current && (logRef.current.scrollTop = logRef.current.scrollHeight));
	};

	const handleAdd = async (contents /* array of JSON strings */) => {
		let lastAdded = null;
		for (const content of contents) {
			const { ok, data, error } = await api.addMaFile(content);
			if (ok) {
				lastAdded = data;
				setAccounts(prev => [data, ...prev.filter(a => a.name !== data.name)]);
			} else {
				alert(error);
			}
		}
		setAddModal(false);
		if (lastAdded) setSelected(lastAdded.name);
	};

	const handleLogin = async (name, password) => {
		const { ok, data, error } = await api.login(name, password || '');
		if (ok && data) return data;
		if (error && error !== 'Требуется пароль для входа') {
			setAccounts(prev => prev.map(a => a.name === name ? { ...a, status: { state: 'error', label: error } } : a));
		}
		return null;
	};

	const applyStatus = (payload) => {
		setAccounts(prev => {
			const idx = prev.findIndex(a => a.name === payload.name);
			if (idx === -1) return [payload, ...prev];
			const next = [...prev];
			next[idx] = { ...next[idx], ...payload };
			return next;
		});
	};

	const respondLoginRequest = async (clientId, version, account, approve) => {
		try {
			const { ok, error } = await api.respondLogin(account, clientId, version, approve);
			if (!ok) throw new Error(error);
		} catch (e) {
			alert(e.message || t('Не удалось подтвердить вход'));
		} finally {
			setLoginRequests(prev => prev.filter(r => !(r.account === account && r.clientId === clientId)));
		}
	};

	if (loading) {
		return (
			<div className="boot">
				<div className="boot-logo">A</div>
				<div className="boot-text">Aura Auth</div>
				<div className="boot-sub">{t('Загрузка…')}</div>
			</div>
		);
	}

	return (
		<div className={`app${logCollapsed ? ' log-collapsed' : ''}`}>
			<aside className="sidebar">
				<div className="brand">
					<div className="brand-logo">A</div>
					<div className="brand-name">{t('Aura Auth')}</div>
					<div className="brand-sub">{t('Steam Manager')}</div>
				</div>

				<div className="sidebar-search">
					<input
						value={search}
						onChange={e => setSearch(e.target.value)}
						placeholder={t('Поиск аккаунта…')}
					/>
				</div>

				<div className="sidebar-tools">
					<button className="icon-btn" type="button" title={t('Настройки')} onClick={() => api.openSettings()}>
						<span className="gear" aria-hidden="true">⚙</span>
					</button>
				</div>

				<div className="account-list">
					{filtered.map(account => {
						const accOffers = offers[account.name];
						const incomingCount = accOffers?.received?.filter(o => o.state === 2 || o.state === 9).length || 0;
						const confCount = confirmations[account.name]?.length || 0;
						return (
						<div
							key={account.name}
							className={`account-item ${selected === account.name ? 'active' : ''}`}
							onClick={() => setSelected(account.name)}
						>
							<span className={`status-dot ${account.status?.state || 'offline'}`} />
							<span className="account-item-name" title={account.name}>{account.label || account.name}</span>
							<span className="account-item-flag">
								{account.play?.state === 'playing' && <span className="mini-chip playing" title={account.play?.state === 'playing' ? t('Играет') : t('Не играет')}>▶</span>}
								{account.autoConfirm && <span className="mini-chip" title={t('Автоподтверждение')}>◈</span>}
								{account.autoAccept && <span className="mini-chip" title={t('Автоприём')}>⇄</span>}
								{!!incomingCount && (
									<span className="mini-chip offers" title={t('Входящих предложений: {n}', { n: incomingCount })}>
										⇩{incomingCount}
									</span>
								)}
								{!!confCount && (
									<span className="mini-chip warns" title={t('Активных подтверждений: {n}', { n: confCount })}>
										⚠{confCount}
									</span>
								)}
							</span>
							<button
								type="button"
								className="account-item-del"
								title={t('Удалить аккаунт')}
								onClick={(e) => {
									e.stopPropagation();
									if (!confirm(t('Удалить аккаунт «{name}»?', { name: account.label || account.name }))) return;
									api.remove(account.name).then(() => {
										setAccounts(prev => prev.filter(a => a.name !== account.name));
										if (selected === account.name) setSelected(null);
									});
								}}
							>✕</button>
						</div>
						);
					})}
					<button className="account-item add" onClick={() => setAddModal(true)}>
						<span className="plus">+</span>
						<span className="account-item-name">{t('Добавить аккаунт')}</span>
					</button>
				</div>

				<div className="sidebar-footer">
					<MassSendPanel
						accounts={accounts}
						presets={APP_PRESETS}
						jobs={massJobs}
						onStart={(name, payload) => api.startMassSend(name, payload.target, payload.opts)}
						onRefresh={(name) => api.listAccounts()}
					/>
				</div>
			</aside>

			<main className="content">
				{loginRequests.length > 0 && (
					<div className="login-requests">
						{loginRequests.map(req => (
							<LoginRequestBanner
								key={`${req.account}::${req.clientId}`}
								request={req}
								onRespond={approve => respondLoginRequest(req.clientId, req.version, req.account, approve)}
							/>
						))}
					</div>
				)}
				{selected ? (
					<AccountCard
						key={selected}
						account={accounts.find(a => a.name === selected) || {}}
						offers={offers[selected]}
						confirmations={confirmations[selected]}
						onLogin={handleLogin}
						onStatus={applyStatus}
						onAutoConfirm={v => api.setAutoConfirm(selected, v)}
						onAutoAccept={v => api.setAutoAccept(selected, v)}
						onAcceptOffer={id => api.acceptOffer(selected, id)}
						onDeclineOffer={id => api.declineOffer(selected, id)}
						onAcceptAllConfirms={() => api.acceptAllConfirmations(selected)}
						onRespondConf={params => api.respondConfirmation(selected, params.id, params.key, params.accept)}
						onRemove={() => api.remove(selected).then(() => {
							setAccounts(prev => prev.filter(a => a.name !== selected));
							setSelected(null);
						})}
						onLogout={() => api.logout(selected).then(() => {
							setAccounts(prev => prev.map(a => a.name === selected ? { ...a, status: { state: 'offline', label: t('Не в сети') } } : a));
						})}
						onRename={async (label) => {
							const r = await api.rename(selected, label);
							if (r && r.ok) {
								setAccounts(prev => prev.map(a => a.name === selected ? { ...a, ...r.data } : a));
							}
							return r;
						}}
						onAutoPlay={(name, enabled) => api.setAutoPlay(selected, enabled)}
						onPlay={(name, appIds) => api.startPlay(selected, appIds)}
						onStopPlay={() => api.stopPlay(selected)}
					/>
				) : (
					<div className="empty-state">
						<div className="empty-icon">⬡</div>
					<div className="empty-title">{t('Нет выбранного аккаунта')}</div>
					<div className="empty-sub">{t('Добавьте аккаунт через maFile и выполните вход')}</div>
					<button className="btn primary" onClick={() => setAddModal(true)}>{t('Добавить аккаунт')}</button>
					</div>
				)}
			</main>

			<LogPanel ref={logRef} logs={logs} scrollToBottom={scrollToBottom} collapsed={logCollapsed} onToggle={() => setLogCollapsed(v => !v)} />

			{addModal && (
				<AddAccountModal
					onClose={() => setAddModal(false)}
					onSubmit={handleAdd}
					onPickFile={() => api.openMaFileDialog()}
				/>
			)}

			{guardPrompt && (
				<GuardModal
					account={guardPrompt}
					onClose={() => { api.submitGuard(guardPrompt, '__cancel__'); setGuardPrompt(null); }}
					onSubmit={code => {
						api.submitGuard(guardPrompt, code);
						setGuardPrompt(null);
					}}
				/>
			)}
		</div>
	);
}

function LoginRequestBanner({ request, onRespond }) {
	const { t } = useI18n();
	const info = request.info || {};
	const platform = info.platformType !== undefined
		? (t({ 2: 'Клиент Steam', 3: 'Веб-браузер', 4: 'Мобильное приложение' }[info.platformType]) || t('Платформа {n}', { n: info.platformType }))
		: '';
	const location = [info.location?.city, info.location?.state, info.location?.geoloc].filter(Boolean).join(', ');
	const when = new Date(request.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
	return (
		<div className="login-request-card">
			<div className="lr-icon">⌘</div>
			<div className="lr-body">
				<div className="lr-title">{t('Запрос входа в Steam')}</div>
				<div className="lr-sub">
					{info.deviceFriendlyName && <span>{t('Устройство: ')}<b>{info.deviceFriendlyName}</b></span>}
					{platform && <span>{platform}</span>}
					{info.ip && <span><b>{info.ip}</b></span>}
					{location && <span>{location}</span>}
					<span>{when}</span>
				</div>
				<div className="lr-account">{t('Аккаунт: ')}{request.account}</div>
			</div>
			<div className="lr-actions">
				<button className="btn small danger" onClick={() => onRespond(false)}>{t('Отклонить')}</button>
				<button className="btn small success" onClick={() => onRespond(true)}>{t('Подтвердить')}</button>
			</div>
		</div>
	);
}