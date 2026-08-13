import React, { useEffect, useState } from 'react';
import { useI18n } from '../i18n.jsx';

export default function MassSendPanel({ accounts, presets, jobs, onStart, onRefresh }) {
	const { t } = useI18n();
	const [open, setOpen] = useState(false);
	const [source, setSource] = useState('');
	const [target, setTarget] = useState('account');
	const [targetName, setTargetName] = useState('');
	const [targetId, setTargetId] = useState('');
	const [preset, setPreset] = useState(presets[0]);
	const [maxItems, setMaxItems] = useState(60);
	const [delay, setDelay] = useState(5000);
	const [onlyTradable, setOnlyTradable] = useState(true);
	const [selected, setSelected] = useState([]);
	const [tradeToken, setTradeToken] = useState('');
	const [recipients, setRecipients] = useState([]);
	const [showSaveRecipient, setShowSaveRecipient] = useState(false);
	const [recipLabel, setRecipLabel] = useState('');
	const [parsedSteamId, setParsedSteamId] = useState(null);
	const [parsedPartner, setParsedPartner] = useState(null);

	const onlineAccounts = accounts.filter(a => a.status?.state === 'online');

	useEffect(() => {
		if (onlineAccounts.length && !source) setSource(onlineAccounts[0].name);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [accounts]);

	useEffect(() => {
		setSelected([]);
	}, [source, preset]);

	useEffect(() => {
		const unsub = window.aura.on('inventory:selected', ids => {
			setSelected(ids || []);
			if (ids && ids.length) setOpen(true);
		});
		window.aura.listRecipients().then(res => {
			if (res && res.ok) setRecipients(res.data || []);
		}).catch(() => {});
		return () => unsub();
	}, []);

	const saveRecipient = async () => {
		if (!targetId.trim()) {
			alert(t('Введите SteamID получателя'));
			return;
		}
		const parsed = parseTradeInput(targetId);
		const canonicalId = parsed.steamID64 || targetId.trim();
		const canonicalToken = parsed.token || tradeToken || '';
		const label = (recipLabel || '').trim() || canonicalId;
		if (!label) {
			alert(t('Введите название получателя'));
			return;
		}
		const res = await window.aura.addRecipient({ label, steamID64: canonicalId, tradeToken: canonicalToken });
		if (res && res.ok && res.data) {
			setRecipients(prev => {
				const withoutDup = prev.filter(r => !(r.steamID64 === canonicalId));
				return [...withoutDup, res.data];
			});
			setTargetId(canonicalId);
			if (canonicalToken) setTradeToken(canonicalToken);
			setRecipLabel('');
			setShowSaveRecipient(false);
			alert(t('Получатель «{name}» сохранён', { name: label }));
		} else if (res && !res.ok) {
			alert(res.error || t('Ошибка сохранения'));
		}
	};

	const removeRecipient = async (id) => {
		await window.aura.removeRecipient(id);
		setRecipients(prev => prev.filter(r => r.id !== id));
	};

	const loadRecipient = (r) => {
		const parsed = parseTradeInput(r.steamID64);
		setTargetId(parsed.steamID64 || r.steamID64);
		setTradeToken(parsed.token || r.tradeToken || '');
	};

	// If the user pastes a full trade URL, extract and fill both ID and token automatically
	const handleTargetIdChange = (value) => {
		setTargetId(value);
		setParsedSteamId(null);
		setParsedPartner(null);
		const parsed = parseTradeInput(value);
		if (parsed.steamID64) setParsedSteamId(parsed.steamID64);
		if (parsed.partner) setParsedPartner(parsed.partner);
		if (parsed.token) setTradeToken(parsed.token);
	};

	const openPicker = () => {
		if (!source) return alert(t('Выберите аккаунт-отправитель'));
		window.aura.openInventory(source, preset.appid, preset.contextid);
	};

	const handleStart = () => {
		if (!source) {
			alert(t('Выберите аккаунт-отправитель'));
			return;
		}
		let targetIdResolved = targetId;
		let tokenResolved = tradeToken;
		if (target === 'account') {
			const acct = accounts.find(a => a.name === targetName);
			if (!acct) return alert(t('Выберите аккаунт-получатель'));
			targetIdResolved = acct.steamID64;
			// Если для этого SteamID сохранён получатель с токеном — подставляем его автоматически
			if (!tokenResolved && recipients.length) {
				const known = recipients.find(r => {
					const resolved = parseTradeInput(r.steamID64).steamID64 || r.steamID64;
					return resolved === targetIdResolved;
				});
				if (known && known.tradeToken) tokenResolved = known.tradeToken;
			}
		} else {
			// Parse a full trade URL if pasted into the SteamID field
			const parsed = parseTradeInput(targetId);
			targetIdResolved = parsed.steamID64 || targetId;
			tokenResolved = parsed.token || tradeToken;
		}
		if (!targetIdResolved) return alert(t('Укажите SteamID получателя или вставьте трейд-ссылку'));
		if (!selected.length) return alert(t('Выберите предметы в окне инвентаря'));

		// Warn when sending to a bare SteamID64 without a token: Steam rejects it unless we're friends.
		if (/^\d{17}$/.test(targetIdResolved) && !tokenResolved) {
			if (!confirm(t('Получатель указан без торгового токена. Steam отклонит отправку (ошибка 15), если вы не друзья.\n\nПродолжить?'))) {
				return;
			}
		}

		// Cross-check against saved recipients: if this SteamID is known with a token, flag a mismatch.
		const known = recipients.find(r => {
			const resolved = parseTradeInput(r.steamID64).steamID64 || r.steamID64;
			return resolved === targetIdResolved;
		});
		if (known) {
			const knownToken = known.tradeToken || parseTradeInput(known.steamID64).token || '';
			if (knownToken && tokenResolved && knownToken !== tokenResolved) {
				if (!confirm(t('У этого получателя сохранён токен «{token}», а вы ввели «{input}». Если токен неверный, Steam отклонит отправку (ошибка 15).\n\nПродолжить с введённым токеном?', { token: knownToken, input: tokenResolved }))) {
					return;
				}
			}
		}

		onStart(source, {
			target: targetIdResolved,
			opts: {
				appId: preset.appid,
				contextId: preset.contextid,
				maxItems: Number(maxItems),
				delayMs: Number(delay),
				onlyTradable,
				assetIds: selected,
				...(tokenResolved.trim() ? { tradeToken: tokenResolved.trim() } : {})
			}
		});
	};

	// Accepts "76561198...", "123456789", or a full trade URL and extracts steamID64 + token
	const parseTradeInput = (input) => {
		const raw = String(input || '').trim();
		const out = { steamID64: null, token: null, partner: null };
		if (/^https?:\/\//.test(raw) && /tradeoffer/i.test(raw)) {
			try {
				const url = new URL(raw);
				const partner = Number(url.searchParams.get('partner'));
				out.partner = url.searchParams.get('partner') || null;
				out.token = url.searchParams.get('token') || null;
				if (partner) {
					// partner in trade URLs is accountid-relative (steamID64 - 76561197960265728).
					// !!! 76561197960265728 exceeds Number.MAX_SAFE_INTEGER, so plain JS arithmetic
					// rounds it and yields a wrong steamID64. Use BigInt for an exact result.
					const BASE = 76561197960265728n;
					out.steamID64 = String(BigInt(partner) + BASE);
				}
			} catch (e) {}
		} else if (/^\d{17}$/.test(raw)) {
			out.steamID64 = raw;
		}
		return out;
	};

	const job = jobs[source];

	return (
		<div className={`mass-panel ${open ? 'open' : ''}`}>
			<button className="mass-header" onClick={() => setOpen(!open)}>
				<span className="mass-icon">⇄</span>
				<div>
					<div className="mass-title">{t('Массовая отправка')}</div>
					<div className="mass-sub">{t('выбрать предметы → отправить аккаунту')}</div>
				</div>
				<span className={`chev ${open ? 'up' : ''}`}>▾</span>
			</button>

			{open && (
				<div className="mass-body">
					<div className="field">
						<label>{t('Аккаунт-отправитель')}</label>
						<select className="select" value={source} onChange={e => setSource(e.target.value)}>
							{onlineAccounts.map(a => <option key={a.name} value={a.name}>{a.label || a.name}</option>)}
							{!onlineAccounts.length && <option value="">{t('Нет онлайн-аккаунтов')}</option>}
						</select>
					</div>

					<div className="field">
						<label>{t('Получатель')}</label>
						<select className="select" value={target} onChange={e => setTarget(e.target.value)}>
							<option value="account">{t('Аккаунт из списка')}</option>
							<option value="id">{t('Сохранённый SteamID')}</option>
						</select>
						{target === 'account' ? (
							<>
								<select className="select" value={targetName} onChange={e => setTargetName(e.target.value)} style={{ marginTop: 8 }}>
									<option value="">{t('— выберите —')}</option>
									{accounts.map(a => <option key={a.name} value={a.name}>{a.label || a.name}</option>)}
								</select>
								<input className="input" style={{ marginTop: 8 }} placeholder={t('Торговый токен получателя (если не в друзьях)')} value={tradeToken} onChange={e => setTradeToken(e.target.value)} />
								{targetName && !tradeToken && (
									<div className="field-hint warn">{t('Если получатель не в друзьях — Steam отклонит (ошибка 15). Укажите токен из его трейд-ссылки.')}</div>
								)}
							</>
						) : (
							<>
								{recipients.length > 0 && (
									<select className="select" style={{ marginTop: 8 }} value="" onChange={e => {
										const r = recipients.find(x => x.id === e.target.value);
										if (r) loadRecipient(r);
									}}>
										<option value="">{t('— сохранённые получатели —')}</option>
										{recipients.map(r => <option key={r.id} value={r.id}>{r.label} ({r.steamID64})</option>)}
									</select>
								)}
								<input className="input" style={{ marginTop: 8 }} placeholder={t('SteamID64 или трейд-ссылка…')} value={targetId} onChange={e => handleTargetIdChange(e.target.value)} />
								{parsedSteamId && (
									<div className="field-hint">
										{t('Ссылка: partner={p} → SteamID {id}', { p: parsedPartner || '?', id: parsedSteamId })}
										{(() => {
											const match = accounts.find(a => a.steamID64 === parsedSteamId);
											return match ? <> {t(' — это аккаунт «{name}» из списка', { name: match.label || match.name })}</> : null;
										})()}
									</div>
								)}
								<input className="input" style={{ marginTop: 8 }} placeholder={t('Торговый токен (если не друзья)')} value={tradeToken} onChange={e => setTradeToken(e.target.value)} />
								<div className="recipient-bar">
									<button className="btn ghost small" onClick={() => setShowSaveRecipient(!showSaveRecipient)} disabled={!targetId.trim()}>
										{showSaveRecipient ? t('Отмена') : t('Запомнить получателя')}
									</button>
									{recipients.filter(r => r.steamID64 === targetId.trim()).map(r => (
										<span key={r.id} className="recipient-chip" title={t('Удалить сохранённого')}>
											{r.label} <b onClick={() => removeRecipient(r.id)}>✕</b>
										</span>
									))}
								</div>
								{showSaveRecipient && (
									<div className="recipient-save-box">
										<input
											className="input"
											placeholder={t('Название (например «Друг 1»)')}
											value={recipLabel}
											onChange={e => setRecipLabel(e.target.value)}
											onKeyDown={e => e.key === 'Enter' && saveRecipient()}
										/>
										<button className="btn primary small" onClick={saveRecipient}>{t('Сохранить')}</button>
									</div>
								)}
							</>
						)}
					</div>

					<div className="field">
						<label>{t('Инвентарь')}</label>
						<select className="select" value={preset.appid} onChange={e => setPreset(presets.find(p => p.appid == e.target.value))}>
							{presets.map(p => <option key={p.appid} value={p.appid}>{p.label} (app {p.appid})</option>)}
						</select>
					</div>

					<div className="field-row">
						<div className="field half">
							<label>{t('Макс. предметов / трейд')}</label>
							<input className="input" type="number" min={1} max={200} value={maxItems} onChange={e => setMaxItems(e.target.value)} />
						</div>
						<div className="field half">
							<label>{t('Пауза, мс')}</label>
							<input className="input" type="number" min={1000} step={1000} value={delay} onChange={e => setDelay(e.target.value)} />
						</div>
					</div>

					<div className="mass-actions">
						<button className="btn primary" onClick={openPicker}>{t('Выбрать предметы…')}</button>
						{selected.length > 0 && <span className="selected-count-label">{t('Выбрано: {n}', { n: selected.length })}</span>}
					</div>
					<label className="checkbox">
						<input type="checkbox" checked={onlyTradable} onChange={e => setOnlyTradable(e.target.checked)} />
						<span>{t('Только трейдовые предметы (фильтр в окне инвентаря)')}</span>
					</label>

					<div className="mass-actions">
						<button className="btn primary" onClick={handleStart} disabled={!source || !selected.length}>
							{t('Отправить ({n})', { n: selected.length })}
						</button>
					</div>

					{job && (
						<div className={`job-status ${job.status}`}>
							<div className="job-line">
								{job.status === 'running' && t('Отправка… {sent}/{total}', { sent: job.sent, total: job.total })}
								{job.status === 'done' && t('Готово: {n} предметов', { n: job.sent })}
								{job.status === 'error' && t('Ошибка: {err}', { err: job.error })}
							</div>
							{job.status === 'running' && job.total > 0 && (
								<div className="progress">
									<div className="progress-fill" style={{ width: `${(job.sent / job.total) * 100}%` }} />
								</div>
							)}
						</div>
					)}
				</div>
			)}
		</div>
	);
}