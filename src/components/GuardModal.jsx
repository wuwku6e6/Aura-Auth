import React, { useState } from 'react';
import { useI18n } from '../i18n.jsx';

export default function GuardModal({ account, onSubmit, onClose }) {
	const { t } = useI18n();
	const [code, setCode] = useState('');
	return (
		<div className="modal-backdrop" onClick={onClose}>
			<div className="modal small-modal" onClick={e => e.stopPropagation()}>
				<div className="modal-header">
					<h2>{t('Вход: {account}', { account })}</h2>
					<button className="modal-close" onClick={onClose}>✕</button>
				</div>
				<div className="modal-body">
					<p>{t('Steam запросил код Steam Guard. Введите код из приложения Steam:')}</p>
					<input
						className="input guard-input"
						autoFocus
						value={code}
						onChange={e => setCode(e.target.value)}
						onKeyDown={e => e.key === 'Enter' && code && onSubmit(code)}
						placeholder="XXXXX"
					/>
				</div>
				<div className="modal-actions">
					<button className="btn primary" disabled={!code} onClick={() => onSubmit(code)}>{t('Отправить')}</button>
				</div>
			</div>
		</div>
	);
}