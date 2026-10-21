import WebGL from 'Utils/WebGL.js';
import SpriteRenderer from '../SpriteRenderer.js';
import _vertexShader from './EntityComposer.vs?raw';
import _fragmentShader from './EntityComposer.fs?raw';

const ATLAS_SIZE = 4096;
const BLOCK_SIZE = 256;
const PADDING = 2;
const compositeUV = new Float32Array(4);
const quad = new Float32Array([-0.5, 0.5, 0, 0, 0.5, 0.5, 1, 0, -0.5, -0.5, 0, 1, 0.5, -0.5, 1, 1]);
const ids = new WeakMap();
let nextId = 1;
let current = null;
let gl = null;
let program = null;
let buffer = null;
let vao = null;
let atlas = null;
let framebuffer = null;
let entries = new Map();
let atlasSize = 0;
let pending = [];
let occupancy = null;
let cellCount = 0;
let nextSlotId = 1;
const leasedSlots = new Set();

function id(value) {
	if (!value || (typeof value !== 'object' && typeof value !== 'function')) return String(value);
	let result = ids.get(value);
	if (!result) ids.set(value, (result = nextId++));
	return result;
}

function makeKey(entity, layers, width, height) {
	const parts = [
		entity._job,
		entity.action,
		entity.direction,
		entity._sex,
		entity._bodypalette,
		entity.robe,
		entity.weapon,
		entity.shield,
		entity.accessory,
		entity.accessory2,
		entity.accessory3,
		entity.hasCart,
		entity.CartNum,
		width,
		height
	];
	for (const layer of layers) {
		parts.push(
			id(layer.frame),
			id(layer.frame.texture),
			id(layer.paletteTexture),
			layer.x,
			layer.y,
			layer.width,
			layer.height,
			layer.angle,
			layer.color.join(','),
			layer.additive ? 1 : 0
		);
	}
	return parts.join('|');
}

function init(context) {
	if (gl === context && atlas) return;
	const activeTexture = context.getParameter(context.ACTIVE_TEXTURE);
	const framebufferBinding = context.getParameter(context.FRAMEBUFFER_BINDING);
	const vaoBinding = context.getParameter(context.VERTEX_ARRAY_BINDING);
	const arrayBufferBinding = context.getParameter(context.ARRAY_BUFFER_BINDING);
	const textureBinding = context.getParameter(context.TEXTURE_BINDING_2D);
	gl = context;
	program = WebGL.createShaderProgram(gl, _vertexShader, _fragmentShader);
	buffer = gl.createBuffer();
	vao = gl.createVertexArray();
	gl.bindVertexArray(vao);
	gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
	gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
	const aPosition = program.attribute.aPosition;
	const aTextureCoord = program.attribute.aTextureCoord;
	gl.enableVertexAttribArray(aPosition);
	gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, 4 * 4, 0);
	gl.enableVertexAttribArray(aTextureCoord);
	gl.vertexAttribPointer(aTextureCoord, 2, gl.FLOAT, false, 4 * 4, 2 * 4);
	gl.bindVertexArray(null);

	atlasSize = Math.min(ATLAS_SIZE, gl.getParameter(gl.MAX_TEXTURE_SIZE));
	atlas = gl.createTexture();
	gl.bindTexture(gl.TEXTURE_2D, atlas);
	gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, atlasSize, atlasSize);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
	framebuffer = gl.createFramebuffer();
	gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
	gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, atlas, 0);
	if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
		throw new Error('[EntityComposer] Composite framebuffer is incomplete');
	}
	gl.bindFramebuffer(gl.FRAMEBUFFER, framebufferBinding);
	gl.bindVertexArray(vaoBinding);
	gl.bindBuffer(gl.ARRAY_BUFFER, arrayBufferBinding);
	gl.bindTexture(gl.TEXTURE_2D, textureBinding);
	gl.activeTexture(activeTexture);
	cellCount = Math.floor(atlasSize / BLOCK_SIZE);
	occupancy = new Int32Array(cellCount * cellCount);
	nextSlotId = 1;
	entries = new Map();
	pending = [];
	leasedSlots.clear();
}

function collect(entity, frame, palette, paletteTexture, pos, additive) {
	if (!current || !frame || frame.width <= 0 || frame.height <= 0) return false;
	const width = Math.abs(SpriteRenderer.size[0]);
	const height = Math.abs(SpriteRenderer.size[1]);
	const angle = SpriteRenderer.angle;
	const radians = (angle / 180) * Math.PI;
	current.layers.push({
		frame,
		palette,
		paletteTexture,
		color: Array.from(SpriteRenderer.color),
		angle,
		zIndex: SpriteRenderer.zIndex,
		width: SpriteRenderer.size[0],
		height: SpriteRenderer.size[1],
		x: pos[0],
		y: pos[1],
		boundsWidth: Math.abs(width * Math.cos(radians)) + Math.abs(height * Math.sin(radians)),
		boundsHeight: Math.abs(width * Math.sin(radians)) + Math.abs(height * Math.cos(radians)),
		additive: !!additive
	});
	return true;
}

function findFreeSlot(width, height) {
	const blocksWide = Math.ceil((width + PADDING * 2) / BLOCK_SIZE);
	const blocksHigh = Math.ceil((height + PADDING * 2) / BLOCK_SIZE);
	if (blocksWide > cellCount || blocksHigh > cellCount) return null;
	for (let y = 0; y <= cellCount - blocksHigh; y++) {
		for (let x = 0; x <= cellCount - blocksWide; x++) {
			let available = true;
			for (let row = 0; row < blocksHigh && available; row++) {
				for (let column = 0; column < blocksWide; column++) {
					if (occupancy[(y + row) * cellCount + x + column]) {
						available = false;
						break;
					}
				}
			}
			if (!available) continue;
			const slotId = nextSlotId++;
			for (let row = 0; row < blocksHigh; row++) {
				for (let column = 0; column < blocksWide; column++)
					occupancy[(y + row) * cellCount + x + column] = slotId;
			}
			return {
				id: slotId,
				x: x * BLOCK_SIZE,
				y: y * BLOCK_SIZE,
				width: blocksWide * BLOCK_SIZE,
				height: blocksHigh * BLOCK_SIZE,
				blocksWide,
				blocksHigh,
				cellX: x,
				cellY: y
			};
		}
	}
	return null;
}

function freeSlot(slot) {
	for (let row = 0; row < slot.blocksHigh; row++) {
		for (let column = 0; column < slot.blocksWide; column++)
			occupancy[(slot.cellY + row) * cellCount + slot.cellX + column] = 0;
	}
}

function getSlot(key, width, height) {
	let slot = entries.get(key);
	if (slot) {
		entries.delete(key);
		entries.set(key, slot);
		return { slot, hit: true };
	}
	slot = findFreeSlot(width, height);
	while (!slot) {
		let oldestKey = Array.from(entries.keys()).find(cacheKey => !leasedSlots.has(entries.get(cacheKey).id));
		if (oldestKey === undefined) {
			if (SpriteRenderer.batchActive) SpriteRenderer.flushBatch();
			leasedSlots.clear();
			oldestKey = entries.keys().next().value;
		}
		if (oldestKey === undefined) return { slot: null, hit: false };
		slot = entries.get(oldestKey);
		freeSlot(slot);
		entries.delete(oldestKey);
		slot = findFreeSlot(width, height);
	}
	entries.set(key, slot);
	return { slot, hit: false };
}

function compose(items) {
	const context = gl;
	const previous = {
		framebuffer: context.getParameter(context.FRAMEBUFFER_BINDING),
		viewport: context.getParameter(context.VIEWPORT),
		scissor: context.getParameter(context.SCISSOR_BOX),
		scissorEnabled: context.isEnabled(context.SCISSOR_TEST),
		depthEnabled: context.isEnabled(context.DEPTH_TEST),
		depthMask: context.getParameter(context.DEPTH_WRITEMASK),
		blendEnabled: context.isEnabled(context.BLEND),
		blendSrcRGB: context.getParameter(context.BLEND_SRC_RGB),
		blendDstRGB: context.getParameter(context.BLEND_DST_RGB),
		blendSrcAlpha: context.getParameter(context.BLEND_SRC_ALPHA),
		blendDstAlpha: context.getParameter(context.BLEND_DST_ALPHA),
		blendEquationRGB: context.getParameter(context.BLEND_EQUATION_RGB),
		blendEquationAlpha: context.getParameter(context.BLEND_EQUATION_ALPHA),
		clearColor: context.getParameter(context.COLOR_CLEAR_VALUE),
		colorMask: context.getParameter(context.COLOR_WRITEMASK),
		program: context.getParameter(context.CURRENT_PROGRAM),
		vao: context.getParameter(context.VERTEX_ARRAY_BINDING),
		arrayBuffer: context.getParameter(context.ARRAY_BUFFER_BINDING),
		activeTexture: context.getParameter(context.ACTIVE_TEXTURE),
		cullEnabled: context.isEnabled(context.CULL_FACE),
		stencilEnabled: context.isEnabled(context.STENCIL_TEST)
	};
	context.activeTexture(context.TEXTURE0);
	previous.texture0 = context.getParameter(context.TEXTURE_BINDING_2D);
	context.activeTexture(context.TEXTURE1);
	previous.texture1 = context.getParameter(context.TEXTURE_BINDING_2D);
	try {
		context.bindFramebuffer(context.FRAMEBUFFER, framebuffer);
		context.viewport(0, 0, atlasSize, atlasSize);
		context.enable(context.SCISSOR_TEST);
		context.disable(context.DEPTH_TEST);
		context.disable(context.CULL_FACE);
		context.disable(context.STENCIL_TEST);
		context.depthMask(false);
		context.colorMask(true, true, true, true);
		context.enable(context.BLEND);
		context.blendEquationSeparate(context.FUNC_ADD, context.FUNC_ADD);
		context.blendFuncSeparate(
			context.SRC_ALPHA,
			context.ONE_MINUS_SRC_ALPHA,
			context.ONE,
			context.ONE_MINUS_SRC_ALPHA
		);
		context.clearColor(0, 0, 0, 0);
		context.clear(context.COLOR_BUFFER_BIT);
		context.useProgram(program);
		context.bindVertexArray(vao);
		context.uniform1i(program.uniform.uDiffuse, 0);
		context.uniform1i(program.uniform.uPalette, 1);
		context.uniform2f(program.uniform.uAtlasSize, atlasSize, atlasSize);
		for (const item of items) {
			context.scissor(item.slot.x, item.slot.y, item.slot.width, item.slot.height);
			context.clear(context.COLOR_BUFFER_BIT);
			context.uniform4f(program.uniform.uSlot, item.slot.x, item.slot.y, item.slot.width, item.slot.height);
			for (const layer of item.work.layers) {
				context.activeTexture(context.TEXTURE0);
				context.bindTexture(context.TEXTURE_2D, layer.frame.texture);
				context.activeTexture(context.TEXTURE1);
				context.bindTexture(context.TEXTURE_2D, layer.paletteTexture);
				context.uniform2f(program.uniform.uTextSize, layer.frame.width * 2, layer.frame.height * 2);
				context.uniform1i(program.uniform.uUsePal, !!layer.paletteTexture);
				context.uniform4fv(program.uniform.uColor, layer.color);
				context.uniform2f(program.uniform.uFrameSize, layer.width, layer.height);
				context.uniform2f(
					program.uniform.uCenter,
					layer.x - item.minX + PADDING,
					layer.y - item.minY + PADDING
				);
				context.uniform1f(program.uniform.uAngle, (layer.angle * Math.PI) / 180);
				context.blendFuncSeparate(
					context.SRC_ALPHA,
					layer.additive ? context.ONE : context.ONE_MINUS_SRC_ALPHA,
					context.ONE,
					layer.additive ? context.ONE : context.ONE_MINUS_SRC_ALPHA
				);
				context.drawArrays(context.TRIANGLE_STRIP, 0, 4);
			}
		}
	} finally {
		context.bindFramebuffer(context.FRAMEBUFFER, previous.framebuffer);
		context.viewport(...previous.viewport);
		context.scissor(...previous.scissor);
		if (previous.scissorEnabled) context.enable(context.SCISSOR_TEST);
		else context.disable(context.SCISSOR_TEST);
		if (previous.depthEnabled) context.enable(context.DEPTH_TEST);
		else context.disable(context.DEPTH_TEST);
		context.depthMask(previous.depthMask);
		context.colorMask(...previous.colorMask);
		if (previous.cullEnabled) context.enable(context.CULL_FACE);
		else context.disable(context.CULL_FACE);
		if (previous.stencilEnabled) context.enable(context.STENCIL_TEST);
		else context.disable(context.STENCIL_TEST);
		if (previous.blendEnabled) context.enable(context.BLEND);
		else context.disable(context.BLEND);
		context.blendFuncSeparate(
			previous.blendSrcRGB,
			previous.blendDstRGB,
			previous.blendSrcAlpha,
			previous.blendDstAlpha
		);
		context.blendEquationSeparate(previous.blendEquationRGB, previous.blendEquationAlpha);
		context.clearColor(...previous.clearColor);
		context.activeTexture(context.TEXTURE0);
		context.bindTexture(context.TEXTURE_2D, previous.texture0);
		context.activeTexture(context.TEXTURE1);
		context.bindTexture(context.TEXTURE_2D, previous.texture1);
		context.activeTexture(previous.activeTexture);
		context.useProgram(previous.program);
		context.bindVertexArray(previous.vao);
		context.bindBuffer(context.ARRAY_BUFFER, previous.arrayBuffer);
	}
}

class EntityComposer {
	static drawLayers(layers) {
		for (const layer of layers) {
			SpriteRenderer.image.texture = layer.frame.texture;
			SpriteRenderer.image.palette = layer.paletteTexture;
			SpriteRenderer.image.frame = null;
			SpriteRenderer.image.spr = null;
			SpriteRenderer.image.uvRect = null;
			SpriteRenderer.image.premultiplied = false;
			SpriteRenderer.image.size[0] = layer.frame.width * 2;
			SpriteRenderer.image.size[1] = layer.frame.height * 2;
			SpriteRenderer.sprite = layer.frame;
			SpriteRenderer.color.set(layer.color);
			SpriteRenderer.size[0] = layer.width;
			SpriteRenderer.size[1] = layer.height;
			SpriteRenderer.offset[0] = layer.x;
			SpriteRenderer.offset[1] = layer.y;
			SpriteRenderer.angle = layer.angle;
			SpriteRenderer.zIndex = layer.zIndex;
			SpriteRenderer.render(layer.additive);
		}
	}

	static contextRestored() {
		current = null;
		gl = null;
		program = null;
		buffer = null;
		vao = null;
		atlas = null;
		framebuffer = null;
		entries = new Map();
		pending = [];
		atlasSize = 0;
		occupancy = null;
		cellCount = 0;
		nextSlotId = 1;
		leasedSlots.clear();
	}

	static begin(entity) {
		current = SpriteRenderer.is3D ? { entity, layers: [] } : null;
	}

	static get active() {
		return !!current;
	}

	static suspend(callback) {
		const work = current;
		current = null;
		try {
			callback();
		} finally {
			current = work;
		}
	}

	static capture(entity, frame, palette, paletteTexture, pos, additive) {
		return collect(entity, frame, palette, paletteTexture, pos, additive);
	}

	static end() {
		const work = current;
		current = null;
		if (!work || !work.layers.length) return;
		const { entity, layers } = work;
		let minX = Infinity,
			minY = Infinity,
			maxX = -Infinity,
			maxY = -Infinity;
		for (const layer of layers) {
			minX = Math.min(minX, layer.x - layer.boundsWidth / 2);
			maxX = Math.max(maxX, layer.x + layer.boundsWidth / 2);
			minY = Math.min(minY, layer.y - layer.boundsHeight / 2);
			maxY = Math.max(maxY, layer.y + layer.boundsHeight / 2);
		}
		const width = Math.max(1, Math.ceil(maxX - minX));
		const height = Math.max(1, Math.ceil(maxY - minY));
		const context = SpriteRenderer.gl;
		if (!context || width > atlasSize - PADDING * 2 || height > atlasSize - PADDING * 2) {
			this.drawLayers(layers);
			return;
		}
		init(context);
		const key = makeKey(entity, layers, width, height);
		const { slot, hit } = getSlot(key, width, height);
		if (!slot) {
			this.drawLayers(layers);
			return;
		}
		leasedSlots.add(slot.id);
		if (!hit) {
			if (SpriteRenderer.batchActive) pending.push({ work, slot, minX, minY, width, height });
			else compose([{ work, slot, minX, minY, width, height }]);
		}
		SpriteRenderer.image.texture = atlas;
		SpriteRenderer.image.palette = null;
		SpriteRenderer.image.frame = null;
		SpriteRenderer.image.spr = null;
		compositeUV[0] = (slot.x + PADDING) / atlasSize;
		compositeUV[1] = (slot.y + slot.height - PADDING) / atlasSize;
		compositeUV[2] = (slot.x + PADDING + width) / atlasSize;
		compositeUV[3] = (slot.y + slot.height - PADDING - height) / atlasSize;
		SpriteRenderer.image.uvRect = compositeUV;
		SpriteRenderer.image.premultiplied = true;
		SpriteRenderer.image.size[0] = width;
		SpriteRenderer.image.size[1] = height;
		SpriteRenderer.sprite = { type: 1 };
		SpriteRenderer.color.set([1, 1, 1, 1]);
		SpriteRenderer.size[0] = width;
		SpriteRenderer.size[1] = height;
		SpriteRenderer.offset[0] = minX + width / 2;
		SpriteRenderer.offset[1] = minY + height / 2;
		SpriteRenderer.angle = 0;
		SpriteRenderer.zIndex = 1;
		SpriteRenderer.render(false);
	}

	static flushPending() {
		const queued = pending;
		pending = [];
		if (queued.length) compose(queued);
	}
}

SpriteRenderer.beforeBatchFlush = () => EntityComposer.flushPending();
SpriteRenderer.afterBatchFlush = () => leasedSlots.clear();

export default EntityComposer;
