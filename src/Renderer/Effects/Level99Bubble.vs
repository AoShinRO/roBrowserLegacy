#version 300 es
precision highp float;

// Per-vertex (static quad, 6 vertices for 2 triangles)
in vec2 aCorner;  // (-1,-1), (1,-1), (1,1), (1,1), (-1,1), (-1,-1)
in vec2 aUV;      // (0,0), (1,0), (1,1), (1,1), (0,1), (0,0)

// Per-instance (updated per frame via _instanceBuffer)
in vec3 aAnchorPos; // anchor.x, anchor.y, anchor.z  in game units
in float aZIndex;   // 0.01 + ec*0.002 + ai*0.0001  (negative = dead/skip)

out vec2 vTextureCoord;
out float vAlpha;

uniform mat4 uModelViewMat;
uniform mat4 uProjectionMat;

// Billboard orientation (computed once per frame in JS)
// x=sinBeta, y=cosBeta, z=sinAlpha, w=cosAlpha
uniform vec4 uBillboard;

// World position of the emitter base (basePos)
uniform vec3 uBasePos;

// Scaling
uniform float uRadius;       // baseRadius * GAME_TO_WORLD * scaleMult
uniform float uGameToWorld;  // GAME_TO_WORLD constant (0.1 * 2.2)

// Alpha computation params (mirrors computeAlpha in JS)
uniform vec2 uAlphaParams; // x=alphaOffset, y=alphaGain

// Per-pass z-fighting offset (0 or pass*0.00005)
uniform float uPassOffset;

void main(void) {
    // Dead/invisible instances: aZIndex < 0 means skip
    // Place off-screen and zero alpha
    if (aZIndex < 0.0) {
        vAlpha = 0.0;
        vTextureCoord = aUV;
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        return;
    }

    float anchorY = aAnchorPos.y;

    // Compute alpha: clamp(250 + gain*(y + offset), 0, 250) / 255
    float alpha255 = 250.0 + uAlphaParams.y * (anchorY + uAlphaParams.x);
    alpha255 = clamp(alpha255, 0.0, 250.0);
    vAlpha = alpha255 / 255.0;

    // Discard invisible anchors
    if (vAlpha <= 0.0) {
        vTextureCoord = aUV;
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        return;
    }

    // Billboard corner rotation (mirrors JS lines 379-393)
    // aCorner.x = local billboard X, aCorner.y = local billboard Z (vertical on quad)
    float localX = aCorner.x * uRadius;
    float localZ = aCorner.y * uRadius;

    float sinBeta  = uBillboard.x;
    float cosBeta  = uBillboard.y;
    float sinAlpha = uBillboard.z;
    float cosAlpha = uBillboard.w;

    // R_x(beta) — pitch rotation
    float ry = -localZ * sinBeta;
    float rz =  localZ * cosBeta;

    // R_y(alpha) — yaw rotation
    float rx = localX * cosAlpha + rz * sinAlpha;
    rz       = -localX * sinAlpha + rz * cosAlpha;

    // Anchor offset converted to world units
    vec3 anchorWorld = aAnchorPos * uGameToWorld;

    // Final world position
    vec3 worldPos = uBasePos + anchorWorld + vec3(rx, ry, rz);

    gl_Position = uProjectionMat * uModelViewMat * vec4(worldPos, 1.0);
    // Apply z-index offset (depth bias to prevent z-fighting between passes/columns)
    gl_Position.z -= (aZIndex + uPassOffset);

    vTextureCoord = aUV;
}