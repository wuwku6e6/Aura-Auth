import React from 'react';
import ReactDOM from 'react-dom/client';
import InventoryWindow from './components/InventoryWindow.jsx';
import { withSettings } from './bootstrap.jsx';
import './styles.css';

const InventoryWrapped = withSettings(InventoryWindow);

ReactDOM.createRoot(document.getElementById('root')).render(
	<React.StrictMode>
		<InventoryWrapped />
	</React.StrictMode>
);