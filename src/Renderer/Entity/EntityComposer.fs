#version 300 es
precision highp float;

in vec2 vTextureCoord;
out vec4 fragColor;

uniform sampler2D uDiffuse;
uniform sampler2D uPalette;
uniform vec2 uTextSize;
uniform bool uUsePal;
uniform vec4 uColor;

vec4 bilinearSample(vec2 uv) {
	vec2 interval = 1.0 / uTextSize;
	float tlIndex = texture(uDiffuse, uv).r;
	float trIndex = texture(uDiffuse, uv + vec2(interval.x, 0.0)).r;
	float blIndex = texture(uDiffuse, uv + vec2(0.0, interval.y)).r;
	float brIndex = texture(uDiffuse, uv + interval).r;
	vec4 transparent = vec4(0.0);
	vec4 tl = tlIndex == 0.0 ? transparent : vec4(texture(uPalette, vec2(tlIndex, 1.0)).rgb, 1.0);
	vec4 tr = trIndex == 0.0 ? transparent : vec4(texture(uPalette, vec2(trIndex, 1.0)).rgb, 1.0);
	vec4 bl = blIndex == 0.0 ? transparent : vec4(texture(uPalette, vec2(blIndex, 1.0)).rgb, 1.0);
	vec4 br = brIndex == 0.0 ? transparent : vec4(texture(uPalette, vec2(brIndex, 1.0)).rgb, 1.0);
	vec2 f = fract(uv * uTextSize);
	return mix(mix(tl, tr, f.x), mix(bl, br, f.x), f.y);
}

void main() {
	vec4 color = uUsePal ? bilinearSample(vTextureCoord) : texture(uDiffuse, vTextureCoord);
	if (color.a == 0.0) discard;
	fragColor = color * uColor;
}
