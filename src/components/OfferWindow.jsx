import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useI18n, tradeOfferStateName } from '../i18n.jsx';

const OfferWindow = () => {
	const { t } = useI18n();
	const api = window.aura;

	const params = useMemo(() => {
		const h = window.location.hash.replace(/^#/, '');
		const sp = new URLSearchParams(h);
		return { name: sp.get('name'), offer: sp.get('offer') };
	}, []);

	const name = params.name;
	const offerId = params.offer;

	const [offer, setOffer] = useState(null);
	const [error, setError] = useState('');
	const [loading, setLoading] = useState(true);
	const [acting, setActing] = useState(false);
	const [result, setResult] = useState('');
	const [debug, setDebug] = useState(null);

	// Сначала берём свежие данные тем же путём, что и главное окно (getOffers).
	// Если кэш Steam в этот момент пуст (транзиентно), подстраховываемся оффером,
	// который мы уже получили из главного окна при клике (он содержит receiveItems/giveItems).
	const load = useCallback(() => {
		setLoading(true);
		setError('');
		Promise.all([
			api.getOffers(name)
				.then(res => {
					const received = res.received || [];
					const sent = res.sent || [];
					const all = [...received, ...sent];
					const norm = s => String(s == null ? '' : s).trim();
					return all.find(o => norm(o.id) === norm(offerId) || Number(o.id) === Number(offerId)) || null;
				})
				.catch(() => null),
			api.getOffer(offerId).catch(() => null)
		]).then(([fresh, stored]) => {
			const found = fresh || stored || null;
			setDebug({ offerId, name: name, source: fresh ? 'getOffers' : (stored ? 'stored' : 'none') });
			setOffer(found);
			setLoading(false);
		});
	}, [name, offerId]);

	useEffect(() => { load(); }, [load]);

		const act = (fn) => {
		setActing(true); setResult('');
		fn(name, offerId)
			.then(() => { setResult(t('Готово')); load(); })
			.catch(err => setResult(t('Ошибка: {msg}', { msg: (err && err.message) || err })))
			.finally(() => setActing(false));
	};
	const onAccept = () => act(api.acceptOffer);
	const onDecline = () => act(api.declineOffer);

	const isActive = offer && (offer.state === 2 || offer.state === 9);
	const isIncoming = offer && offer.isOurOffer === false;

	return (
		<div className="offer-win">
			<div className="offer-win-head">
				<div className="offer-win-title">
					<div className="offer-win-account">{name}</div>
					<div className="offer-win-sub">{t('Предложение #{offerId}', { offerId })}{offer ? ` · ${t(tradeOfferStateName(offer.state))}` : ''}</div>
				</div>
				{(!loading && !error) && (
					<div className="offer-win-head-actions">
						<button className="btn success" disabled={acting || (offer && !isActive)} onClick={onAccept}>{t('Принять')}</button>
						<button className="btn danger" disabled={acting || (offer && !isActive)} onClick={onDecline}>{t('Отклонить')}</button>
					</div>
				)}
			</div>

			{loading && <div className="inv-win-empty">{t('Загрузка…')}</div>}
			{error && <div className="inv-win-error">{error}</div>}
			{!loading && !error && !offer && (
				<div className="inv-win-empty">{t('Предложение не найдено (возможно, уже обработано).')}
					{debug && (
						<pre className="offer-diag">{t('ищем id={id} (name={name})\nисточник: {source}', { id: debug.offerId, name: debug.name, source: debug.source })}</pre>
					)}
				</div>
			)}

			{!loading && !error && offer && (
				<div className="offer-win-body">
					{offer.message && <div className="offer-win-msg">{t('Сообщение: ')}{offer.message}</div>}
					{offer.partner && <div className="offer-win-partner">{t('Партнёр: ')}{offer.partner}</div>}

					<OfferGroup title={t('Они предлагают')} items={offer.receiveItems} />
					<OfferGroup title={t('Вы отдаёте')} items={offer.giveItems} />

					{result && <div className="offer-win-result">{result}</div>}

					{isIncoming && !isActive && (
						<div className="offer-win-note">{t('Предложение не активно (статус: {label}).', { label: t(tradeOfferStateName(offer.state)) })}</div>
					)}
				</div>
			)}
		</div>
	);
};

function OfferGroup({ title, items }) {
	const { t } = useI18n();
	return (
		<div className="offer-group">
			<div className="offer-group-label">
				{title}{items && items.length ? ` (${items.length})` : ''}
			</div>
			{!items || items.length === 0
				? <div className="offer-empty-side">{t('— пусто —')}</div>
				: (
					<div className="offer-items">
						{items.map((it, idx) => (
							<div className="offer-item" key={`${it.marketHashName || it.name}_${idx}`}>
								<div className="offer-item-icon">
									{it.icon
										? <img src={it.icon} alt="" loading="lazy" onError={e => { e.currentTarget.style.display = 'none'; }} />
										: <div className="offer-item-noicon">?</div>}
								</div>
								<div className="offer-item-info">
									<div className="offer-item-name" title={it.name}>{it.name}</div>
									<div className="offer-item-meta">
										{it.exteriorShort && (
											<span className="offer-ext-badge" data-ex={it.exteriorShort} title={it.exterior || ''}>{it.exteriorShort}</span>
										)}
										{it.amount > 1 && <span className="offer-item-amount">×{it.amount}</span>}
										{it.rarity && <span className="offer-item-rarity">{it.rarity}</span>}
									</div>
								</div>
							</div>
						))}
					</div>
				)}
		</div>
	);
}

export default OfferWindow;
