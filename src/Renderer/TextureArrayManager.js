/**
 * Renderer/TextureArrayManager.js
 *
 * Packs RGBA sprite textures into a single gl.TEXTURE_2D_ARRAY so that
 * the SpriteBatcher can draw multiple sprites per draw call without
 * rebinding the texture for each sprite.
 *
 * This file is part of ROBrowser, (http://www.robrowser.com/).
 */

export default class TextureArrayManager {
	constructor(gl, options = {}) {
		this._gl = gl;
		this._layerSize = options.layerSize || 128;
		this._initialCap = options.initialCapacity || 64;
		this._maxCap = options.maxCapacity || 128;

		this._texture = null;
		this._capacity = 0;
		this._nextFreeLayer = 0;

		// Map<WebGLTexture, { layer, uvScaleX, uvScaleY, width, height }>
		this._entries = new Map();

		this._readFBO = null;
		this._drawFBO = null;

		this._init();
	}

	get texture() {
		return this._texture;
	}
	get capacity() {
		return this._capacity;
	}
	get usedLayers() {
		return this._nextFreeLayer;
	}

	_init() {
		const gl = this._gl;
		this._readFBO = gl.createFramebuffer();
		this._drawFBO = gl.createFramebuffer();

		const cap = Math.min(this._initialCap, this._maxCap);
		this._texture = this._createArrayTexture(cap);
		this._capacity = cap;
		this._nextFreeLayer = 0;
	}

	_createArrayTexture(capacity) {
		const gl = this._gl;
		const tex = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
		gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, this._layerSize, this._layerSize, capacity);
		gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
		return tex;
	}

	getLayerFromPixels(srcTexture, pixels, width, height) {
		const cached = this._entries.get(srcTexture);
		if (cached) return cached;

		if (width > this._layerSize || height > this._layerSize) return null;
		if (this._nextFreeLayer >= this._capacity && !this._grow()) return null;

		const layer = this._nextFreeLayer++;
		const gl = this._gl;

		gl.bindTexture(gl.TEXTURE_2D_ARRAY, this._texture);
		gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, layer, width, height, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
		gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);

		const entry = {
			layer,
			width,
			height,
			uvScaleX: width / this._layerSize,
			uvScaleY: height / this._layerSize
		};
		this._entries.set(srcTexture, entry);
		return entry;
	}

	/**
	 * @param {WebGLTexture} srcTexture
	 * @param {number} width
	 * @param {number} height
	 * @returns {{layer:number, uvScaleX:number, uvScaleY:number}|null}
	 */
	getLayer(srcTexture, width, height) {
		const cached = this._entries.get(srcTexture);
		if (cached) return cached;

		if (width > this._layerSize || height > this._layerSize) {
			return null;
		}

		if (this._nextFreeLayer >= this._capacity) {
			if (!this._grow()) return null;
		}

		const layer = this._nextFreeLayer++;
		this._blitIntoLayer(srcTexture, layer, width, height);

		const entry = {
			layer,
			width,
			height,
			uvScaleX: width / this._layerSize,
			uvScaleY: height / this._layerSize
		};
		this._entries.set(srcTexture, entry);
		return entry;
	}

	_grow() {
		if (this._capacity >= this._maxCap) return false;
		const newCap = Math.min(this._capacity * 2, this._maxCap);

		const gl = this._gl;
		const oldTex = this._texture;
		const newTex = this._createArrayTexture(newCap);

		const prevRead = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
		const prevDraw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING);

		for (let i = 0; i < this._nextFreeLayer; i++) {
			gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this._readFBO);
			gl.framebufferTextureLayer(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, oldTex, 0, i);

			gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this._drawFBO);
			gl.framebufferTextureLayer(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, newTex, 0, i);

			gl.blitFramebuffer(
				0,
				0,
				this._layerSize,
				this._layerSize,
				0,
				0,
				this._layerSize,
				this._layerSize,
				gl.COLOR_BUFFER_BIT,
				gl.NEAREST
			);
		}

		gl.bindFramebuffer(gl.READ_FRAMEBUFFER, prevRead);
		gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, prevDraw);

		gl.deleteTexture(oldTex);
		this._texture = newTex;
		this._capacity = newCap;
		return true;
	}

	_blitIntoLayer(srcTexture, layer, width, height) {
		const gl = this._gl;
		const prevRead = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
		const prevDraw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING);

		gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this._readFBO);
		gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, srcTexture, 0);

		gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this._drawFBO);
		gl.framebufferTextureLayer(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, this._texture, 0, layer);

		const status = gl.checkFramebufferStatus(gl.READ_FRAMEBUFFER);
		if (status !== gl.FRAMEBUFFER_COMPLETE) {
			this._nextFreeLayer--;
			gl.bindFramebuffer(gl.READ_FRAMEBUFFER, prevRead);
			gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, prevDraw);
			return null;
		}

		gl.blitFramebuffer(0, 0, width, height, 0, 0, width, height, gl.COLOR_BUFFER_BIT, gl.NEAREST);

		gl.bindFramebuffer(gl.READ_FRAMEBUFFER, prevRead);
		gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, prevDraw);
	}

	dispose() {
		const gl = this._gl;
		if (this._texture) gl.deleteTexture(this._texture);
		if (this._readFBO) gl.deleteFramebuffer(this._readFBO);
		if (this._drawFBO) gl.deleteFramebuffer(this._drawFBO);
		this._entries.clear();
		this._texture = null;
		this._readFBO = null;
		this._drawFBO = null;
		this._capacity = 0;
		this._nextFreeLayer = 0;
	}
}
