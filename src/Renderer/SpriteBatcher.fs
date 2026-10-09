#version 300 es
precision highp float;
precision highp sampler2DArray;

in vec2  vTextureCoord;
in vec2  vUv;
in vec4  vColor;
in float vShadow;
in vec2  vTextSize;
flat in int vTextureLayer;
flat in int   vFlags;
out vec4 fragColor;

uniform sampler2D      uDiffuse;
uniform sampler2D      uPalette;
uniform sampler2DArray uSpriteArray;

uniform bool  uFogUse;
uniform float uFogNear;
uniform float uFogFar;
uniform vec3  uFogColor;

const int FLAG_USE_PAL   = 2;
const int FLAG_USE_ARRAY = 16;

vec4 bilinearSample(vec2 uv, sampler2D indexT, sampler2D LUT, vec2 textSize) {
    vec2 TextInterval = 1.0 / textSize;

    float tlLUT = texture(indexT, uv).x;
    float trLUT = texture(indexT, uv + vec2(TextInterval.x, 0.0)).x;
    float blLUT = texture(indexT, uv + vec2(0.0, TextInterval.y)).x;
    float brLUT = texture(indexT, uv + TextInterval).x;

    vec4 transparent = vec4(0.0);

    vec4 tl = tlLUT == 0.0 ? transparent : vec4(texture(LUT, vec2(tlLUT, 1.0)).rgb, 1.0);
    vec4 tr = trLUT == 0.0 ? transparent : vec4(texture(LUT, vec2(trLUT, 1.0)).rgb, 1.0);
    vec4 bl = blLUT == 0.0 ? transparent : vec4(texture(LUT, vec2(blLUT, 1.0)).rgb, 1.0);
    vec4 br = brLUT == 0.0 ? transparent : vec4(texture(LUT, vec2(brLUT, 1.0)).rgb, 1.0);

    vec2 f  = fract(uv.xy * textSize);
    vec4 tA = mix(tl, tr, f.x);
    vec4 tB = mix(bl, br, f.x);

    return mix(tA, tB, f.y);
}

void main(void) {
    if (vColor.a == 0.0) {
        discard;
    }

    vec4 textureSample;

    if ((vFlags & FLAG_USE_ARRAY) != 0) {
        textureSample = texture(uSpriteArray, vec3(vUv, float(vTextureLayer)));
    } else if ((vFlags & FLAG_USE_PAL) != 0) {
        textureSample = bilinearSample(vTextureCoord, uDiffuse, uPalette, vTextSize);
    } else {
        textureSample = texture(uDiffuse, vTextureCoord.st);
    }

    if (textureSample.a == 0.0) {
        discard;
    }

    textureSample.rgb *= vShadow;
    fragColor = textureSample * vColor;

    if (uFogUse) {
        float depth     = gl_FragCoord.z / gl_FragCoord.w;
        float fogFactor = smoothstep(uFogNear, uFogFar, depth);
        fragColor       = mix(fragColor, vec4(uFogColor, fragColor.w), fogFactor);
    }
}