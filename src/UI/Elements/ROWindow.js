/**
 * @HTMLElement ROWindow
 * @author AoShinHo
 */

import Mouse from 'Controls/MouseEventHandler.js';
import Cursor from 'UI/CursorManager.js';
import EntityManager from 'Renderer/EntityManager.js';
import Events from 'Core/Events.js';
import Renderer from 'Renderer/Renderer.js';
import Session from 'Engine/SessionStorage.js';
import UIPreferences from 'Preferences/UI.js';

class ROWindow extends HTMLElement {
	static observedAttributes = ['dock', 'css'];

	constructor() {
		super();
		this._shadow = this.attachShadow({ mode: 'open' });
		this.magnet = { TOP: false, BOTTOM: false, LEFT: false, RIGHT: false };
		this.needFocus = true;
		this.__active = false;
		this.__loaded = false;
	}

	connectedCallback() {
		// CSS isolation via <link> inside Shadow DOM
		const cssPath = this.getAttribute('css');
		if (cssPath) {
			const link = document.createElement('link');
			link.rel = 'stylesheet';
			link.href = cssPath;
			this._shadow.appendChild(link);
		}

		// Slot for content
		const slot = document.createElement('slot');
		this._shadow.appendChild(slot);

		// Mouse intersection blocking (replaces UIComponent.prepare lines 119-165)
		this._setupMouseBlocking();

		// Draggable if dock attribute present
		if (this.hasAttribute('dock')) {
			this._setupDraggable(this.getAttribute('dock-handle'));
		}

		this.__loaded = true;
		this.style.zIndex = this.style.zIndex || '50';
	}

	_setupMouseBlocking() {
		let _intersect,
			_enter = 0;
		this.addEventListener('mouseenter', () => {
			if (_enter === 0) {
				_intersect = Mouse.intersect;
				_enter++;
				if (_intersect) {
					Mouse.intersect = false;
					Cursor.setType(Cursor.ACTION.DEFAULT);
					EntityManager.setOverEntity(null);
				}
			}
		});
		this.addEventListener('mouseleave', () => {
			if (_enter > 0) {
				_enter--;
				if (_enter === 0 && _intersect) {
					if (!Session.FreezeUI) Mouse.intersect = true;
					EntityManager.setOverEntity(null);
				}
			}
		});
		this.addEventListener('touchstart', e => e.stopImmediatePropagation());
		this.addEventListener('mousedown', () => {
			if (this.manager) this.focus();
		});
	}

	_setupDraggable(handleSelector) {
		const handle = handleSelector ? this.querySelector(handleSelector) || this : this;
		// ... draggable logic from UIComponent.draggable (lines 495-716)
		// Uses native pointer events instead of jQuery
		// Same magnet/snap logic, same opacity animation
		handle.addEventListener('pointerdown', event => {
			if (event.button !== 0) return;
			const startX = this.offsetLeft - event.clientX;
			const startY = this.offsetTop - event.clientY;

			const onMove = e => {
				const x = e.clientX + startX;
				const y = e.clientY + startY;
				// ... magnet/snap logic (same as UIComponent)
				this.style.left = x + 'px';
				this.style.top = y + 'px';
			};

			const onUp = () => {
				window.removeEventListener('pointermove', onMove);
				window.removeEventListener('pointerup', onUp);
			};

			window.addEventListener('pointermove', onMove);
			window.addEventListener('pointerup', onUp);
		});
	}

	// Interface compatible with UIManager
	focus() {
		if (!this.manager || !this.needFocus) return;
		const components = this.manager.components;
		// ... same zIndex logic as UIComponent.focus (lines 379-416)
		// but using this.style.zIndex instead of jQuery .css('zIndex')
		let maxZ = 50;
		for (const name in components) {
			const c = components[name];
			if (c !== this && c.__active && c.needFocus) {
				const z = parseInt(c.ui ? c.ui[0].style.zIndex : c.style.zIndex, 10) || 50;
				if (z > maxZ) maxZ = z;
			}
		}
		this.style.zIndex = maxZ + 1;
	}

	// Compatibility: UIManager accesses component.ui[0] for getBoundingClientRect
	get ui() {
		// Minimal shim so UIManager.fixResizeOverflow works
		const self = this;
		return {
			0: self,
			length: 1,
			get [Symbol.iterator]() {
				return [self][Symbol.iterator];
			}
		};
	}
}

customElements.define('ro-window', ROWindow);
export default ROWindow;
