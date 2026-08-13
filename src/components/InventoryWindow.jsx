import React, { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../i18n.jsx';

export default function InventoryWindow() {
	const { t } = useI18n();
	const [items, setItems] = useState(null);
	const [error, setError] = useState('');
	const [selected, setSelected] = useState([]);
	const [onlyTradable, setOnlyTradable] = useState(false);
	const [query, setQuery] = useState('');

	const params = useMemo(() => {
		const h = decodeURIComponent(window.location.hash.replace(/^#/, ''));
		const p = {};
		for (const pair of h.split('&')) {
			const [k, v] = pair.split('=');
			if (k) p[k] = v;
		}
		return p;
	}, []);

	const { name, app, ctx } = params;

			useEffect(() => {
				window.aura.getInventory(name, Number(app), Number(ctx))
					.then(res => {
						if (res && res.ok) setItems(res.data || []);
						else setError((res && res.error) || t('Не удалось загрузить инвентарь'));
					})
					.catch(err => setError(err.message || String(err)));
			}, [name, app, ctx]);

	const visible = useMemo(() => {
		let list = items || [];
		if (onlyTradable) list = list.filter(i => i.tradable);
		if (query) {
			const q = query.toLowerCase();
			list = list.filter(i => i.marketName.toLowerCase().includes(q));
		}
		return list;
	}, [items, onlyTradable, query]);

	const toggle = (assetid) => setSelected(prev => prev.includes(assetid) ? prev.filter(a => a !== assetid) : [...prev, assetid]);

	const allOn = visible.length > 0 && visible.every(i => selected.includes(i.assetid));
	const toggleAll = () => {
		const ids = visible.map(i => i.assetid);
		setSelected(prev => allOn ? prev.filter(a => !ids.includes(a)) : [...new Set([...prev, ...ids])]);
	};

	return (
		<div className="inv-win">
			<header className="inv-win-header">
				<div className="inv-win-title">
					<div className="inv-win-account">{name}</div>
					<div className="inv-win-sub">{t('Инвентарь app {app} / {ctx}', { app, ctx })}</div>
				</div>
				<div className="inv-win-tools">
					<input className="input" placeholder={t('Поиск…')} value={query} onChange={e => setQuery(e.target.value)} />
					<label className="checkbox">
						<input type="checkbox" checked={onlyTradable} onChange={e => setOnlyTradable(e.target.checked)} />
						<span>{t('Только трейдовые')}</span>
					</label>
					<label className="checkbox">
						<input type="checkbox" checked={allOn} onChange={toggleAll} />
						<span>{t('Выбрать все ({n})', { n: visible.length })}</span>
					</label>
					<span className="inv-win-count">{t('Выбрано: {n}', { n: selected.length })}</span>
				</div>
			</header>

			{error && <div className="inv-win-error">{error}</div>}

			{!items && !error && <div className="inv-win-loading">{t('Загрузка инвентаря…')}</div>}

			{items && (
				<div className="inv-win-grid">
					{visible.length === 0 && <div className="inv-win-empty">{t('Нет предметов')}</div>}
					{visible.map(item => (
						<button
							key={item.assetid}
							className={`inv-card ${selected.includes(item.assetid) ? 'on' : ''} ${item.tradable ? '' : 'untradable'}`}
							onClick={() => toggle(item.assetid)}
						>
							{item.icon ? (
								<img className="inv-card-img" src={item.icon} alt="" loading="lazy" onError={e => { e.currentTarget.style.display = 'none'; }} />
							) : (
								<div className="inv-card-noimg">?</div>
							)}
							<div className="inv-card-name">{item.marketName}</div>
							<div className="inv-card-meta">
								{!item.tradable && (
									<span className="inv-badge red">
										{item.tradeHoldDays > 0 ? t('трейд-холд {n} дн.', { n: item.tradeHoldDays }) : t('не трейдовый')}
									</span>
								)}
								{item.amount > 1 && <span className="inv-badge">x{item.amount}</span>}
							</div>
						</button>
					))}
				</div>
			)}

			{selected.length > 0 && (
				<footer className="inv-win-footer">
					<span>{t('Выбрано: {n}', { n: selected.length })}</span>
					<button className="btn primary" onClick={() => { window.aura.selectInventory(selected); window.close(); }}>{t('Вернуть в приложение')}</button>
				</footer>
			)}
		</div>
	);
}