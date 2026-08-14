import React, { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../i18n.jsx';

const RARITY_NUM = [0, 1, 2, 3, 4, 5];

const normKey = (n) => String(n || '')
	.replace(/StatTrak™\s*/g, '')
	.replace(/\s*★\s*/g, '')
	.replace(/\s*\([^)]*\)\s*$/, '')
	.trim();

const RECIPE_NAMES = ['Consumer → Industrial', 'Industrial → Mil-Spec', 'Mil-Spec → Restricted', 'Restricted → Classified', 'Classified → Covert'];
const recipeSummary = (r) => RECIPE_NAMES[r % 10] || 'рецепт {r}';

// Короткие обозначения экстерьера по float (для бейджей входных предметов).
const EXT_BY_FLOAT = [
	{ max: 0.07, short: 'FN' },
	{ max: 0.15, short: 'MW' },
	{ max: 0.38, short: 'FT' },
	{ max: 0.45, short: 'WW' },
	{ max: 1.0, short: 'BS' },
];
const extShort = (f) => {
	if (f == null || !Number.isFinite(f)) return null;
	for (const e of EXT_BY_FLOAT) if (f <= e.max) return e.short;
	return 'BS';
};

export default function Cs2TradeWindow() {
	const [items, setItems] = useState(null);
	const [error, setError] = useState('');
	const [history, setHistory] = useState([]);
	const [showHistory, setShowHistory] = useState(false);
	const [selected, setSelected] = useState([]);
	const [onlyTradable, setOnlyTradable] = useState(false);
	const [query, setQuery] = useState('');
	const [rarityFilter, setRarityFilter] = useState(null); // 0..4 (Consumer..Classified)
	const [statTrakOnly, setStatTrakOnly] = useState(false);
	const [crafting, setCrafting] = useState(false);
	const [notice, setNotice] = useState('');
	const [ev, setEv] = useState(null);
	const [evError, setEvError] = useState('');
	const [evIcons, setEvIcons] = useState({});
	const [tip, setTip] = useState(null);
	const { t } = useI18n();

	const params = useMemo(() => {
		const h = decodeURIComponent(window.location.hash.replace(/^#/, ''));
		const p = {};
		for (const pair of h.split('&')) {
			const [k, v] = pair.split('=');
			if (k) p[k] = v;
		}
		return p;
	}, []);

	const name = params.name;

	const load = () => {
		setError(''); setNotice(''); setSelected([]);
		// Сначала пробуем через GC (нужно для крафта), при неудаче — веб-сессия
		window.aura.getCs2Inventory(name)
			.then(res => {
				if (res && res.ok) {
					setItems(res.data || []);
				} else {
					return window.aura.getCs2InventoryWeb(name).then(res2 => {
						if (res2 && res2.ok) {
							setItems(res2.data || []);
							setNotice(t('Режим просмотра без запуска игры (GC недоступен) — крафт будет недоступен'));
							
						} else {
							const errMsg = res2 && res2.error ? res2.error : (res && res.error);
							setError(errMsg || t('Не удалось загрузить инвентарь CS2'));
						}
					});
				}
			})
			.catch(err => {
				window.aura.getCs2InventoryWeb(name).then(res2 => {
					if (res2 && res2.ok) {
						setItems(res2.data || []);
						setNotice(t('Режим просмотра без запуска игры (GC недоступен) — крафт будет недоступен'));
						
					} else {
						setError(t('Ошибка инвентаря: {err}', { err: err.message || String(err) }));
					}
				}).catch(() => setError(t('Ошибка инвентаря: {err}', { err: err.message || String(err) })));
			});
	};

	const loadHistory = () => {
		window.aura.getCs2History(name)
			.then(res => { if (res && res.ok) setHistory(res.data || []); })
			.catch(() => { /* история некритична */ });
	};

	useEffect(() => { load(); loadHistory(); /* eslint-disable-next-line */ }, [name]);

	// Редкость нужного контракта определяется по первым 10 выбранным предметам.
	const selectedRarity = useMemo(() => {
		if (selected.length < 1 || !items) return null;
		const byId = new Map(items.map(i => [i.assetid, i]));
		const first = byId.get(selected[0]);
		return first ? first.rarity : null;
	}, [selected, items]);

	const selectedItems = useMemo(() => {
		if (!items) return [];
		const byId = new Map(items.map(i => [i.assetid, i]));
		return selected.map(id => byId.get(id)).filter(Boolean);
	}, [items, selected]);

	// Выходы контракта (вероятности/коллекции) показываем МГНОВЕННО, без ожидания цен.
	useEffect(() => {
		setEv(null);
		setEvError('');
		if (selectedItems.length !== 10) return;
		const names = Array.from(new Set(selectedItems.map(i => i.marketHashName))).filter(Boolean);
		if (!names.length) return;
		// Передаём входы вместе с реальными float — они нужны для расчёта
		// итогового экстерьера (качества) выхода контракта.
		const inputs = selectedItems.map(i => ({ name: i.marketHashName, float: i.float != null ? i.float : null }));
		let active = true;
		(async () => {
			try {
				const res = await window.aura.getCs2Tradeup(name, inputs);
				if (!active) { return; }
				if (!res || !res.ok) {
					setEvError(t('Не удалось расчитать EV: {err}', { err: (res && res.error) || t('нет данных от сервера') }));
					return;
				}
				const data = res.data || {};
				const candidates = Array.isArray(data) ? data : (data.candidates || []);
				const collections = Array.isArray(data) ? [] : (data.collections || []);
				if (!candidates.length) {
					setEvError(t('Нет данных по коллекциям для этих предметов (не найдены в базе Trade-Up или предметы разной редкости)'));
					return;
				}
				// Показываем сразу, цены подгрузятся отдельным эффектом.
				setEv({ candidates: candidates.map(c => ({ ...c, price: null, icon: null })), collections, expected: null, qualityChances: data.qualityChances || null, qualityNote: data.qualityNote || null });
			} catch (e) {
				setEvError(t('Ошибка расчёта EV: {err}', { err: e.message || String(e) }));
			}
		})();
		return () => { active = false; };
	}, [selectedItems, items]);

	// Иконки выходов грузим отдельно (Steam CDN), по одной, кэш в бэкенде.
	useEffect(() => {
		if (!ev || !Array.isArray(ev.candidates) || !ev.candidates.length) return;
		const need = Array.from(new Set(ev.candidates.map(c => c.name))).filter(Boolean).filter(n => !(n in evIcons));
		if (!need.length) return;
		let active = true;
		(async () => {
			for (const n of need) {
				if (!active || (n in evIcons)) continue;
				try {
					const res = await window.aura.getCs2Icon(name, n);
					if (!active) break;
					const url = res && res.ok ? res.data : null;
					if (url) setEvIcons(prev => ({ ...prev, [n]: url }));
				} catch (e) { /* иконки некритичны */ }
			}
		})();
		return () => { active = false; };
	}, [ev, name]);

	// Обогащаем кандидатов иконками (цены не используем).
	const evEnriched = useMemo(() => {
		if (!ev || !Array.isArray(ev.candidates)) return null;
		const iconMap = new Map();
		for (const it of (items || [])) {
			const k = normKey(it.marketHashName);
			if (k && it.icon && !iconMap.has(k)) iconMap.set(k, it.icon);
		}
		const candidates = ev.candidates.map(c => {
			const icon = iconMap.get(normKey(c.name)) || evIcons[c.name] || null;
			return { ...c, icon };
		});
		return { candidates, collections: ev.collections || [], expected: null, qualityChances: ev.qualityChances || null, qualityNote: ev.qualityNote || null };
	}, [ev, evIcons, items]);

	const showTip = (e, c) => setTip({ x: e.clientX, y: e.clientY, c });
	const moveTip = (e) => setTip(t => (t ? { ...t, x: e.clientX, y: e.clientY } : t));
	const hideTip = () => setTip(null);

	const visible = useMemo(() => {
		let list = items || [];
		if (onlyTradable) list = list.filter(i => i.tradable);
		if (statTrakOnly) list = list.filter(i => i.statTrak);
		if (rarityFilter !== null) list = list.filter(i => i.rarity === rarityFilter);
		// Если уже выбрали предметы — показываем только их редкость (контракт строго одной редкости).
		if (selected.length > 0 && selectedRarity !== null) list = list.filter(i => i.rarity === selectedRarity);
		if (query) {
			const q = query.toLowerCase();
			list = list.filter(i => i.marketName.toLowerCase().includes(q));
		}
		return list;
	}, [items, onlyTradable, statTrakOnly, rarityFilter, selected, selectedRarity, query]);

	const toggle = (assetid) => {
		setNotice('');
		setSelected(prev => {
			if (prev.includes(assetid)) return prev.filter(a => a !== assetid);
			if (prev.length >= 10) return prev; // максимум 10
			return [...prev, assetid];
		});
	};

	const rarityCount = (r) => {
		let list = items || [];
		if (onlyTradable) list = list.filter(i => i.tradable);
		if (statTrakOnly) list = list.filter(i => i.statTrak);
		return list.filter(i => i.rarity === r).length;
	};

	const selectedCount = selected.length;
	const canCraft = selectedCount === 10;

	const doCraft = async () => {
		if (!canCraft || crafting) return;
		setCrafting(true);
		setNotice('');
		try {
			const res = await window.aura.cs2Craft(name, selected);
			if (res && res.ok === false) {
				setError(res.error || t('Контракт не выполнен'));
			} else {
				setNotice(t('Контракт выполнен! Получено: {n} предмет(ов)', { n: ((res?.data?.itemsGained) || []).length }));
				setSelected([]);
				loadHistory();
				setTimeout(load, 500);
			}
		} catch (e) {
			setError(e.message || String(e));
		} finally {
			setCrafting(false);
		}
	};

	const recipeLabel = (i) => {
		if (i.recipe < 0) return t('нельзя');
		const r = i.recipe % 10;
		const TARGET = {
			weapon: ['Industrial', 'Mil-Spec', 'Restricted', 'Classified', 'Covert'],
			sticker: ['High Grade', '?', 'Remarkable', 'Exotic', 'Extraordinary'],
			capsule: ['High Grade', '?', 'Remarkable', 'Exotic', 'Extraordinary']
		};
		const from = i.rarityName || (['Consumer', 'Industrial', 'Mil-Spec', 'Restricted', 'Classified'][r]);
		const to = (TARGET[i.kind] || TARGET.weapon)[r];
		return i.statTrak ? `StatTrak: ${from} → ${to}` : `${from} → ${to}`;
	};

	return (
		<div className="inv-win cs2-win">
			<header className="inv-win-header">
				<div className="inv-win-title">
					<div className="inv-win-account">{name}</div>
					<div className="inv-win-sub">{t('CS2 Trade-Up контракты · выберите 10 предметов одной редкости')}</div>
				</div>
				<div className="inv-win-tools">
					<input className="input" placeholder={t('Поиск…')} value={query} onChange={e => setQuery(e.target.value)} />
					<label className="checkbox">
						<input type="checkbox" checked={onlyTradable} onChange={e => setOnlyTradable(e.target.checked)} />
						<span>{t('Только трейдовые')}</span>
					</label>
					<label className="checkbox">
						<input type="checkbox" checked={statTrakOnly} onChange={e => setStatTrakOnly(e.target.checked)} />
						<span>StatTrak</span>
					</label>
					<button className="btn small ghost" onClick={load}>{t('Обновить')}</button>
					<span className="inv-win-count">{t('Выбрано: {n}/10', { n: selectedCount })}</span>
				</div>
			</header>

			<div className="cs2-rarity-bar">
				<button className={`chip ${rarityFilter === null ? 'sel' : ''}`} onClick={() => setRarityFilter(null)}>{t('Все')}</button>
				{RARITY_NUM.map(r => (
					<button
						key={r}
						className={`chip ${rarityFilter === r ? 'sel' : ''}`}
						onClick={() => setRarityFilter(r)}
						disabled={!items}
					>
						{['Consumer', 'Industrial', 'Mil-Spec', 'Restricted', 'Classified', 'Covert'][r]}
						<span className="chip-count">{rarityCount(r)}</span>
					</button>
				))}
				{selected.length === 10 && (
					<span className="cs2-recipes">
						{t('Рецепт: {r}', { r: items && items.find(i => selected.includes(i.assetid)) ? recipeLabel(items.find(i => selected.includes(i.assetid))) : '' })}
					</span>
				)}
			</div>

			{selected.length > 0 && (
				<div className="cs2-selected-strip">
					{Array.from({ length: 10 }).map((_, i) => {
						const id = selected[i];
						const it = id != null && items ? items.find(x => x.assetid === id) : null;
						return (
							<div key={i} className={`cs2-sel-slot ${it ? 'on' : ''}`}>
								{it ? (
									<div className="cs2-sel-inner">
										{it.icon
											? <img className="cs2-sel-img" src={it.icon} alt="" loading="lazy" onError={e => { e.currentTarget.style.display = 'none'; }} />
											: <div className="cs2-sel-noimg">?</div>}
										{it.float != null && (
											<div className="cs2-sel-info">
												<span className="cs2-ev-ext-badge" data-ex={extShort(it.float)} title={it.exterior || extShort(it.float)}>{extShort(it.float)}</span>
												<span className="cs2-sel-float">{it.float.toFixed(4)}</span>
											</div>
										)}
										<button className="cs2-sel-remove" title={t('Убрать')} onClick={() => toggle(it.assetid)}>×</button>
									</div>
								) : (
									<span className="cs2-sel-empty">{i + 1}</span>
								)}
							</div>
						);
					})}
					{selected.length < 10 && <span className="cs2-sel-hint">{t('выбрано {n}/10 — кликни предмет, чтобы добавить, × — чтобы убрать', { n: selected.length })}</span>}
				</div>
			)}

			{error && <div className="inv-win-error">{error}</div>}
			{notice && <div className="inv-win-error cs2-notice">{notice}</div>}

			{!items && !error && <div className="inv-win-loading">{t('Подключение к серверам CS2 (GC)…')}</div>}

			{items && (
				<div className="inv-win-grid">
					{visible.length === 0 && <div className="inv-win-empty">{t('Нет предметов для контракта')}</div>}
					{visible.map(item => (
							<button
								key={item.assetid}
								className={`inv-card ${selected.includes(item.assetid) ? 'on' : ''} ${item.tradable ? '' : 'untradable'}`}
								onClick={() => toggle(item.assetid)}
							disabled={item.recipe < 0 && !selected.includes(item.assetid)}
						>
							{item.icon ? (
								<img className="inv-card-img" src={item.icon} alt="" loading="lazy" onError={e => { e.currentTarget.style.display = 'none'; }} />
							) : (
								<div className="inv-card-noimg">?</div>
							)}
							<div className="inv-card-name">{item.marketName}</div>
							<div className="inv-card-sub">
								{item.float != null && <span className="cs2-ev-ext-badge" data-ex={extShort(item.float)} title={item.exterior || extShort(item.float)}>{extShort(item.float)}</span>}
								{item.float != null && <span className="inv-card-floatval">{item.float.toFixed(4)}</span>}
							</div>
							<div className="inv-card-meta">
								{item.rarityName && item.kind !== 'weapon' && <span className="inv-badge">{item.rarityName}</span>}
								{item.statTrak && <span className="inv-badge gold">StatTrak</span>}
								{!item.tradable && <span className="inv-badge red">{t('не трейдовый')}</span>}
								{item.recipe < 0 && <span className="inv-badge red">Covert</span>}
								{item.amount > 1 && <span className="inv-badge">x{item.amount}</span>}
							</div>
						</button>
					))}
				</div>
			)}

			{selectedCount > 0 && (
				<footer className="inv-win-footer">
					<span>{t('Выбрано: {n}/10. Нужно ещё {m}.', { n: selectedCount, m: (10 - selectedCount) })}
					{evError && <span className="inv-win-error cs2-ev-error">{evError}</span>}
					<button className="btn primary" disabled={!canCraft || crafting} onClick={doCraft}>
						{crafting ? t('Выполняется…') : t('Выполнить контракт')}
					</button>
				</span>
			</footer>
			)}

			{evEnriched && Array.isArray(evEnriched.candidates) && evEnriched.candidates.length > 0 && (
				<div className="cs2-ev-candidates">
					<div className="cs2-ev-title">{t('Возможные выходы контракта')}</div>

					<div className="cs2-ev-grid">
						{evEnriched.candidates.map((c, i) => (
							<div
								key={(c && c.name) || i}
								className="cs2-ev-tile"
								data-r={c && typeof c.rarity === 'number' ? c.rarity : ''}
								onMouseEnter={e => showTip(e, c)}
								onMouseMove={moveTip}
								onMouseLeave={hideTip}
							>
								<EvTileIcon c={c} />
								<div className="cs2-ev-tile-name" title={c && c.name ? c.name : ''}>{c && c.name ? c.name : '—'}</div>
								<div className="cs2-ev-tile-meta">
									<span className="cs2-ev-tile-coll" title={c.collections && c.collections.join(', ')}>{c.collections && c.collections.length ? c.collections[0] : '—'}</span>
									<span className="cs2-ev-tile-chance">{c && typeof c.percent === 'number' ? c.percent.toFixed(2) : '—'} %</span>
								</div>
								<div className="cs2-ev-tile-float">{t('Float:')} {c && c.outFloat != null ? c.outFloat.toFixed(4) : '—'}</div>
								<div className="cs2-ev-tile-foot">
									{c && c.exteriorShort && <span className="cs2-ev-ext-badge cs2-ev-tile-ext" data-ex={c.exteriorShort} title={c.exterior || c.qualityLabel || ''}>{c.exteriorShort}</span>}
								</div>
							</div>
						))}
					</div>
				</div>
			)}

			<div className="cs2-history">
				<button className="cs2-history-toggle" onClick={() => setShowHistory(v => !v)}>
					{t('История контрактов ({n})', { n: history.length })} {showHistory ? '▾' : '▸'}
				</button>
				{showHistory && (
					<div className="cs2-history-list">
						{history.length === 0 && <div className="inv-win-empty">{t('Пока нет выполненных контрактов')}</div>}
						{history.map((h, idx) => (
							<div key={`${h.ts}_${idx}`} className="cs2-history-item">
								<div className="cs2-history-head">
									<span className="cs2-history-date">{new Date(h.ts).toLocaleString('ru-RU')}</span>
									<span className="cs2-history-recipe">{t(recipeSummary(h.recipe), { r: h.recipe })}</span>
									<span className="cs2-history-total">{t('Вход: ')}<b>{h.input && h.input.length ? h.input.length : '—'} предм.</b></span>
									<span className="cs2-history-gained">{t('Получил: ')}<b>{h.gained && h.gained.length ? h.gained.map(g => g.name).join(', ') : '—'}</b></span>
								</div>
								<div className="cs2-history-input">
									{(h.input || []).map(x => x.name).join('; ')}
								</div>
							</div>
						))}
					</div>
				)}
			</div>

			{tip && tip.c && (
				<div className="cs2-ev-tip" style={{ left: tip.x + 16, top: tip.y + 16 }}>
					<div className="cs2-ev-tip-name">{tip.c.name}</div>
					<div className="cs2-ev-tip-row"><span>{t('Качество:')}</span><b>{tip.c.exterior || '—'}</b></div>
					<div className="cs2-ev-tip-row"><span>{t('Float:')}</span><b>{tip.c.outFloat != null ? tip.c.outFloat.toFixed(4) : '—'}</b></div>
					<div className="cs2-ev-tip-row"><span>{t('Шанс:')}</span><b>{tip.c.percent != null ? tip.c.percent.toFixed(2) + ' %' : '—'}</b></div>
					<div className="cs2-ev-tip-row"><span>{t('Коллекция:')}</span><b>{tip.c.collections && tip.c.collections.length ? tip.c.collections.join(', ') : '—'}</b></div>
				</div>
			)}
		</div>
	);
}

function EvTileIcon({ c }) {
	const [loaded, setLoaded] = useState(false);
	const rarity = c && typeof c.rarity === 'number' ? c.rarity : '';
	return (
		<div className="cs2-ev-tile-icon">
			{c?.exteriorShort && (
				<span className="cs2-ev-ext-badge cs2-ev-ext-badge-tile" data-ex={c.exteriorShort} title={c.exterior + (c.outFloat != null ? ` · float ${c.outFloat}` : '')}>{c.exteriorShort}</span>
			)}
			{c?.icon ? (
				<>
					{!loaded && <span className="cs2-ev-icon-ph" data-r={rarity}>?</span>}
					<img
						className="cs2-ev-icon"
						src={c.icon}
						alt=""
						loading="lazy"
						onLoad={() => setLoaded(true)}
						onError={e => { setLoaded(false); e.currentTarget.style.display = 'none'; }}
					/>
				</>
			) : (
				<span className="cs2-ev-icon-ph" data-r={rarity}>?</span>
			)}
		</div>
	);
}