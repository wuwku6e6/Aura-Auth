import React, { forwardRef, useEffect } from 'react';
import { useI18n } from '../i18n.jsx';

const LogPanel = forwardRef(function LogPanel({ logs, scrollToBottom, collapsed, onToggle }, ref) {
	const { t } = useI18n();
	useEffect(() => { scrollToBottom(); }, [logs.length]);

	const levelIcon = {
		info: 'ℹ',
		warn: '⚠',
		error: '✕',
		success: '✓'
	};

	return (
		<div className="log-panel">
			<div className="log-header">
				<button className="log-toggle" onClick={onToggle} title={collapsed ? t('Развернуть журнал') : t('Свернуть журнал')}>
					{collapsed ? '▸' : '▾'}
				</button>
				<span className="log-title">{t('Журнал')}</span>
				<span className="log-count">{logs.length}</span>
			</div>
			{!collapsed && (
			<div className="log-body" ref={ref}>
				{logs.map(entry => (
					<div className={`log-line ${entry.level}`} key={entry.id}>
						<span className="log-icon">{levelIcon[entry.level] || '·'}</span>
						<span className="log-time">{new Date(entry.ts).toLocaleTimeString()}</span>
						<span className="log-scope">{entry.scope}</span>
						<span className="log-msg">{entry.message}</span>
					</div>
				))}
			</div>
			)}
		</div>
	);
});

export default LogPanel;