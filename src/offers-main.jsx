import React from 'react';
import ReactDOM from 'react-dom/client';
import OfferWindow from './components/OfferWindow.jsx';
import { withSettings } from './bootstrap.jsx';
import './styles.css';

const OfferWrapped = withSettings(OfferWindow);

class ErrorBoundary extends React.Component {
	constructor(props) {
		super(props);
		this.state = { error: null, info: null, key: 0 };
	}
	static getDerivedStateFromError(error) {
		return { error };
	}
	componentDidCatch(error, info) {
		console.error('OfferWindow crash:', error, info);
		this.setState({ info });
	}
	retry = () => this.setState(s => ({ error: null, info: null, key: s.key + 1 }));
	render() {
		if (this.state.error) {
			const e = this.state.error;
			const msg = (e && e.message) ? e.message : String(e);
			const stack = (e && e.stack) ? e.stack : '';
			const comp = (this.state.info && this.state.info.componentStack) ? this.state.info.componentStack : '';
			return (
				<div className="inv-win-error cs2-crash">
					<b>Окно предложения аварийно завершило работу.</b>
					<div className="cs2-crash-msg">{msg}</div>
					<textarea className="cs2-crash-stack" readOnly value={stack + '\n\nCOMPONENT STACK:\n' + comp} />
					<button className="btn" onClick={this.retry}>Попробовать снова</button>
				</div>
			);
		}
		return <div key={this.state.key}>{this.props.children}</div>;
	}
}

ReactDOM.createRoot(document.getElementById('root')).render(
	<React.StrictMode>
		<ErrorBoundary>
			<OfferWrapped />
		</ErrorBoundary>
	</React.StrictMode>
);
