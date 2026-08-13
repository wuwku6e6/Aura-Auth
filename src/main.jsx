import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import { withSettings } from './bootstrap.jsx';
import './styles.css';

const AppWrapped = withSettings(App);

ReactDOM.createRoot(document.getElementById('root')).render(
	<React.StrictMode>
		<AppWrapped />
	</React.StrictMode>
);