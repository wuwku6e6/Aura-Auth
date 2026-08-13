import React, { useEffect, useState } from 'react';
import { useI18n } from '../i18n.jsx';
import { THEMES, THEME_LABELS } from '../theme.js';

const LANGUAGES = [
	{ id: 'ru', labelRu: 'Русский', labelEn: 'Russian' },
	{ id: 'en', labelRu: 'Английский', labelEn: 'English' }
];

const SettingsWindow = () => {
	const { t, lang } = useI18n();
	const api = window.aura;
	const [language, setLanguage] = useState(lang);
	const [theme, setTheme] = useState((document.documentElement.getAttribute('data-theme')) || 'aura');
	const [version, setVersion] = useState('');
	const [updateInfo, setUpdateInfo] = useState(null);
	const [progress, setProgress] = useState(0);

	useEffect(() => {
		let cancelled = false;
		api.getVersion().then(v => { if (!cancelled) setVersion(v); });
		api.checkForUpdates().then(r => { if (!cancelled) setUpdateInfo(r); });
		const off = api.on('app:updateAvailable', (p) => { if (!cancelled) setUpdateInfo(p); });
		const offProg = api.on('app:updateProgress', (p) => { if (!cancelled) setProgress(p.percent); });
		return () => { cancelled = true; off(); offProg(); };
	}, []);

	const langLabel = (l) => (lang === 'en' ? l.labelEn : l.labelRu);
	const themeLabel = (id) => (lang === 'en' ? THEME_LABELS[id].en : THEME_LABELS[id].ru);

	const onLanguage = (id) => {
		setLanguage(id);
		api.setSettings({ language: id });
	};
	const onTheme = (id) => {
		setTheme(id);
		api.setSettings({ theme: id });
	};

	const doUpdateNow = async () => {
		if (updateInfo?.downloaded) {
			await api.installUpdate();
		} else if (updateInfo?.available) {
			setUpdateInfo({ ...updateInfo, downloading: true });
			await api.installUpdate();
		}
	};
	const doUpdateLater = () => {
		setUpdateInfo({ ...updateInfo, dismissed: true });
	};

	const showUpdateBanner = updateInfo && updateInfo.available && !updateInfo.dismissed;

	return (
		<div className="settings-win">
			{showUpdateBanner && (
				<div className="update-banner">
					<div className="update-banner_title">
						{t('Доступно обновление')} {updateInfo.version}
					</div>
					{!updateInfo.downloading ? (
						<>
							{updateInfo.downloaded ? (
								<button className="update-btn update-btn_apply" onClick={doUpdateNow}>
									{t('Установить')}
								</button>
							) : (
								<button className="update-btn update-btn_apply" onClick={doUpdateNow}>
									{t('Обновить сейчас')}:{progress}%
								</button>
							)}
							<button className="update-btn update-btn_later" onClick={doUpdateLater}>
								{t('Позже')}
							</button>
						</>
					) : (
						<div className="update-progress">{Math.round(progress)}%</div>
					)}
				</div>
			)}
			<div className="settings-head">
				<div className="settings-title">{t('Настройки')}</div>
			</div>
			<div className="settings-body">
				<div className="settings-field">
					<div className="settings-field-label">{t('Язык')}</div>
					<div className="settings-options">
						{LANGUAGES.map(l => (
							<button
								key={l.id}
								type="button"
								className={`settings-option ${language === l.id ? 'sel' : ''}`}
								onClick={() => onLanguage(l.id)}
							>{langLabel(l)}</button>
						))}
					</div>
				</div>

				<div className="settings-field">
					<div className="settings-field-label">{t('Тема')}</div>
					<div className="settings-options">
						{THEMES.map(th => (
							<button
								key={th.id}
								type="button"
								className={`settings-option ${theme === th.id ? 'sel' : ''}`}
								onClick={() => onTheme(th.id)}
							>{themeLabel(th.id)}</button>
						))}
					</div>
				</div>

				<div className="settings-field">
					<div className="settings-field-label">{t('Версия')}</div>
					<div className="settings-field-value">{version || '…'}</div>
				</div>
			</div>
			<div className="settings-foot">{version ? `Aura Auth v${version}` : ''}</div>
		</div>
	);
};

export default SettingsWindow;
