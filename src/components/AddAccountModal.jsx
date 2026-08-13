import React, { useRef, useState } from 'react';
import { useI18n } from '../i18n.jsx';

export default function AddAccountModal({ onClose, onSubmit, onPickFile }) {
	const { t } = useI18n();
	const [files, setFiles] = useState([]);
	const [busy, setBusy] = useState(false);
	const fileInput = useRef(null);

	const handlePick = async () => {
		const { ok, data } = await onPickFile();
		if (ok && data.length) {
			const parsed = data.map(f => {
				try { return { file: f.file, parsed: JSON.parse(f.content) }; } catch (e) { return { file: f.file, error: e.message }; }
			});
			setFiles(parsed);
		}
	};

	const handleDrop = (e) => {
		e.preventDefault();
		const list = Array.from(e.dataTransfer.files);
		readFiles(list);
	};

	const readFiles = (list) => {
		const out = [];
		for (const f of list) {
			const reader = new FileReader();
			reader.onload = () => {
				try { out.push({ file: f.name, parsed: JSON.parse(reader.result) }); }
				catch (err) { out.push({ file: f.name, error: err.message }); }
				setFiles([...out]);
			};
			reader.readAsText(f);
		}
	};

	const handleSubmit = () => {
		const valid = files.filter(f => f.parsed);
		if (!valid.length) return;
		onSubmit(valid.map(f => JSON.stringify(f.parsed)));
	};

	return (
		<div className="modal-backdrop" onClick={onClose}>
			<div className="modal" onClick={e => e.stopPropagation()}>
				<div className="modal-header">
					<h2>{t('Добавить аккаунт')}</h2>
					<button className="modal-close" onClick={onClose}>✕</button>
				</div>

				<div
					className="dropzone"
					onClick={() => fileInput.current && fileInput.current.click()}
					onDragOver={e => e.preventDefault()}
					onDrop={handleDrop}
				>
					<input
						ref={fileInput}
						type="file"
						multiple
						accept=".maFile,.json,.txt"
						style={{ display: 'none' }}
						onChange={e => readFiles(Array.from(e.target.files))}
					/>
					<div className="dz-icon">⇩</div>
					<div className="dz-title">{t('Перетащите maFile сюда')}</div>
					<div className="dz-sub">{t('или кликните для выбора файла')}</div>
					<button className="btn ghost small" onClick={e => { e.stopPropagation(); handlePick(); }}>{t('Выбрать через окно')}</button>
				</div>

				{files.length > 0 && (
					<div className="file-list">
						{files.map((f, i) => (
							<div className={`file-item ${f.error ? 'err' : ''}`} key={i}>
								<span className="file-name">{f.file}</span>
								{f.error ? (
									<span className="file-err">{f.error}</span>
								) : (
									<span className="file-ok">
										{f.parsed.account_name || '?'} — {f.parsed.shared_secret ? '2FA ✓' : t('без shared_secret')}
									</span>
								)}
							</div>
						))}
					</div>
				)}

				<div className="modal-actions">
					<button className="btn primary" disabled={!files.some(f => f.parsed) || busy} onClick={handleSubmit}>
						{t('Добавить')}
					</button>
				</div>
			</div>
		</div>
	);
}