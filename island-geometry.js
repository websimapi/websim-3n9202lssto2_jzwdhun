import * as THREE from 'three';
import { noise3D } from './math-utils.js';

export const ISLAND_ANGULAR_RADIUS = Math.PI / 3.0; 

// Simple FBM for better terrain detail
function fbm(x, y, z, octaves = 3, lacunarity = 2.0, gain = 0.5) {
    let total = 0;
    let amplitude = 1;
    let frequency = 1;
    for(let i=0; i<octaves; i++) {
        total += noise3D(x * frequency, y * frequency, z * frequency) * amplitude;
        amplitude *= gain;
        frequency *= lacunarity;
    }
    return total;
}

// Calculate the radial extent of the island at a given angle, making the coastline irregular
function getCoastLimit(theta, R, seed, sizeScale) {
    // Map theta to 2D noise circle
    const cx = Math.cos(theta);
    const cz = Math.sin(theta);
    
    // 1. Low freq shape noise (The main irregular blobs)
    const shapeNoise = noise3D(cx * 2.5 + seed, cz * 2.5 + seed, seed * 0.1);
    
    // 2. Med freq noise (coastline detail)
    const medNoise = noise3D(cx * 6.0 + seed, cz * 6.0 + seed, seed + 10);
    
    // 3. High freq noise (jagged edges)
    const jagged = noise3D(cx * 15.0 + seed, cz * 15.0 + seed, seed + 20);
    
    // Combine
    // Base coverage increased for "bigger" feeling
    let limit = R * 0.75 * sizeScale;
    
    // Dynamic shape variations
    const totalNoise = 0.4 * shapeNoise + 0.15 * medNoise + 0.04 * jagged;
    limit *= (1.0 + totalNoise);
    
    return limit;
}

// Helper to get height offset for the rocky underside of the island
export function calculateIslandBottomHeight(x, y, z, R, phi, maxPhi, seed = 0, sizeScale = 1.0) {
    return 0; // Deprecated: No bottom geometry generated anymore
}

export function calculateIslandHeight(x, y, z, R, seed = 0, sizeScale = 1.0) {
    const theta = Math.atan2(z, x);
    const currentR = Math.sqrt(x*x + z*z);
    const coastLimit = getCoastLimit(theta, R, seed, sizeScale);
    
    // Normalize radial distance (0 at center, 1 at edge)
    const rNorm = currentR / coastLimit;
    
    if (rNorm >= 1.0) {
        // Underwater slope - gentle falloff
        const slope = (rNorm - 1.0) * (R * 0.3);
        return -slope; 
    }
    
    // Distance from coast (0 at edge, 1 at center)
    const d = 1.0 - rNorm;
    
    // Smoother Profile from Beach to Plateau
    
    // Base slope for beach (subtle rise)
    const beachRise = d * (R * 0.03);
    
    // Main landmass rise 
    // Earlier start for land, smoother transition
    const landStart = 0.15;
    const landEnd = 0.6;
    const landEase = THREE.MathUtils.smoothstep(d, landStart, landEnd);
    const landRise = landEase * (R * 0.18 * sizeScale);
    
    let h = beachRise + landRise;
    
    // 3. Noise
    // Fade in noise as we go inland so beach stays sandy smooth
    const noiseAmp = THREE.MathUtils.smoothstep(d, 0.15, 0.5);
    const terrain = fbm(x * 0.4 + seed, y * 0.4, z * 0.4, 4, 2.0, 0.5);
    h += terrain * (R * 0.04) * noiseAmp; 
    
    // 4. River Generation
    const riverNoise = noise3D(x * 0.15 + seed, z * 0.15, seed * 2);
    const riverVal = Math.abs(riverNoise);
    const riverWidth = 0.08 * sizeScale; 
    
    if (riverVal < riverWidth) {
        // 0 at bank, 1 at center
        const t = (riverWidth - riverVal) / riverWidth;
        // Smooth channel shape
        const dig = t * t * (3 - 2 * t);
        
        // Force height down to underwater level at river center
        // Target height is slightly below zero to let natural blue water sphere show
        const bedHeight = -0.02 * R;
        
        // Blend current height to bed height based on dig strength
        h = THREE.MathUtils.lerp(h, bedHeight, dig);
    }
    
    // Smoothing at water edge
    if (d < 0.02 && h > 0) {
        h *= THREE.MathUtils.smoothstep(d, 0.0, 0.02);
    }

    return h;
}

export function createIslandMesh(radius, seed = 0, sizeScale = 1.0) {
    // High resolution mesh for detail
    const widthSegs = 200;
    const heightSegs = 120; // Reduced as we cover less surface area
    
    // Create only the top cap of the sphere
    const geometry = new THREE.SphereGeometry(
        radius, 
        widthSegs, 
        heightSegs, 
        0, Math.PI * 2, 
        0, ISLAND_ANGULAR_RADIUS 
    );
    
    const posAttribute = geometry.attributes.position;
    const count = posAttribute.count;
    const colors = [];
    
    // Palette
    const cDeepWater = new THREE.Color(0x224488);
    const cSand = new THREE.Color(0xf0e68c);      // Khaki
    const cWetSand = new THREE.Color(0xd2b48c);   // Tan
    const cGrass = new THREE.Color(0x55aa55);     // Green
    const cDryGrass = new THREE.Color(0x88aa55);  // Yellow-Green
    const cForest = new THREE.Color(0x226622);    // Dark Green
    const cRock = new THREE.Color(0x666666);      // Grey

    const v = new THREE.Vector3();

    for (let i = 0; i < count; i++) {
        let x = posAttribute.getX(i);
        let y = posAttribute.getY(i);
        let z = posAttribute.getZ(i);

        // We no longer calculate 'bottom' geometry.
        // The mesh is just the top cap.
        const hOffset = calculateIslandHeight(x, y, z, radius, seed, sizeScale);
        
        // Apply height
        v.set(x, y, z).normalize().multiplyScalar(radius + hOffset);
        posAttribute.setXYZ(i, v.x, v.y, v.z);
        
        // --- Biome Coloring ---
        let c = new THREE.Color();
        const hRel = hOffset / radius; // Normalized height relative to radius
        
        if (hRel < -0.02) {
             // Deep water / Underwater slope
             c.copy(cDeepWater);
             c.lerp(cWetSand, 0.2); // Slight blend
        } else if (hRel < 0.005) {
             // Shallow water / Wet Sand
             c.copy(cWetSand).lerp(cDeepWater, Math.abs(hRel) * 40.0);
        } else {
            // Land Biomes
            const moisture = fbm(x * 0.2 + seed, y * 0.2, z * 0.2, 2) + 0.5;
            
            if (hRel < 0.04) {
                // Expansive Beach
                c.copy(cSand);
                if (moisture > 0.65) c.lerp(cGrass, 0.2); 
                c.offsetHSL(0, 0, (Math.random()-0.5)*0.05);
            } else if (hRel < 0.12) {
                // Main Plateau (Forest/Grass)
                if (moisture < 0.35) {
                    c.copy(cDryGrass);
                } else if (moisture < 0.65) {
                    c.copy(cGrass);
                } else {
                    c.copy(cForest);
                }
                const grassTex = noise3D(x*10, z*10, seed);
                c.offsetHSL(0, 0, grassTex * 0.03);
                
            } else {
                c.copy(cRock);
                c.lerp(cGrass, 0.4);
            }
        }
        
        colors.push(c.r, c.g, c.b);
    }
    
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geometry.computeVertexNormals();

    // Fix Seam Normals (average start and end columns)
    const norms = geometry.attributes.normal;

    for (let y = 0; y <= heightSegs; y++) {
        const idxA = y * (widthSegs + 1);
        const idxB = idxA + widthSegs;
        
        const mx = (norms.getX(idxA) + norms.getX(idxB)) * 0.5;
        const my = (norms.getY(idxA) + norms.getY(idxB)) * 0.5;
        const mz = (norms.getZ(idxA) + norms.getZ(idxB)) * 0.5;
        
        const len = Math.sqrt(mx*mx + my*my + mz*mz);
        if (len > 0) {
            const nx = mx/len, ny = my/len, nz = mz/len;
            norms.setXYZ(idxA, nx, ny, nz);
            norms.setXYZ(idxB, nx, ny, nz);
        }
    }
    norms.needsUpdate = true;
    
    // Standard Material with vertex colors
    // We will inject shader logic for tides in the generator
    const material = new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.9,
        metalness: 0.0,
        flatShading: false
    });
    
    const mesh = new THREE.Mesh(geometry, material);
    return mesh;
}