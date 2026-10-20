#version 300 es
precision highp float;

in vec2 vTextureCoord;
in float vAlpha;

out vec4 fragColor;

uniform sampler2D uDiffuse;
uniform vec4 uColor;    // rgb = tint color, a ignored (alpha comes from vAlpha)
uniform bool uSolidBg;  // debug background path

uniform bool  uFogUse;
uniform float uFogNear;
uniform float uFogFar;
uniform vec3  uFogColor;

void main(void) {
    vec4 textureSample = texture(uDiffuse, vTextureCoord.st);

    if (uSolidBg) {
        // Debug background: use uColor.a directly (solid colored quads)
        fragColor = vec4(uColor.rgb, uColor.a);
    } else {
        // Normal bubble: modulate texture by tint color and per-instance alpha
        fragColor = textureSample * vec4(uColor.rgb, vAlpha);
    }

    if (uFogUse) {
        float depth = gl_FragCoord.z / gl_FragCoord.w;
        float fogFactor = smoothstep(uFogNear, uFogFar, depth);
        fragColor = mix(fragColor, vec4(uFogColor, fragColor.w), fogFactor);
    }
}