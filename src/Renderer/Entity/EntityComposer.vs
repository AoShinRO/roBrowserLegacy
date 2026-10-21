#version 300 es
precision highp float;

in vec2 aPosition;
in vec2 aTextureCoord;
out vec2 vTextureCoord;

uniform vec2 uAtlasSize;
uniform vec4 uSlot;
uniform vec2 uFrameSize;
uniform vec2 uCenter;
uniform float uAngle;

void main() {
	vec2 local = aPosition * uFrameSize;
	float c = cos(uAngle);
	float s = sin(uAngle);
	vec2 rotated = vec2(c * local.x + s * local.y, -s * local.x + c * local.y);
	float x = uSlot.x + uCenter.x + rotated.x;
	float y = uSlot.y + uSlot.w - uCenter.y + rotated.y;
	gl_Position = vec4(x / uAtlasSize.x * 2.0 - 1.0, y / uAtlasSize.y * 2.0 - 1.0, 0.0, 1.0);
	vTextureCoord = aTextureCoord;
}
