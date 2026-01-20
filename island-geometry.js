import * as THREE from 'three';
import { noise3D } from './math-utils.js';

export const ISLAND_ANGULAR_RADIUS = Math.PI / 2.2; 

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
    
    // Low freq shape noise (The main irregular blobs)
    const shapeNoise = noise3D(cx * 1.5 + seed, cz * 1.5 + seed, seed * 0.1);
    
    // Med freq noise (coastline jaggedness)
    const jagged = noise3D(cx * 4 + seed, cz * 4 + seed, seed + 20);
    
    // Combine
    // Base coverage is about 60-70% of the mesh radius, scaled by sizeScale
    let limit = R * 0.65 * sizeScale;
    
    // Add variations
    limit *= (1.0 + 0.3 * shapeNoise + 0.05 * jagged);
    
    return limit;
}

// Helper to get height offset for the rocky underside of the island
export function calculateIslandBottomHeight(x, y, z, R, phi, maxPhi, seed = 0, sizeScale = 1.0) {
    // Current radial distance from center (approx)
    const theta = Math.atan2(z, x);
    const coastLimit = getCoastLimit(theta, R, seed, sizeScale);
    
    // Current radius on plane
    const currentR = Math.sqrt(x*x + z*z);
    
    // Normalize distance relative to coast
    // If currentR > coastLimit, we are outside the main chunk, taper fast
    const t = currentR / coastLimit;

    // Rock depth
    // Deepest part is at center (t=0), depth ~ R*0.6
    let depth = R * 0.6 * sizeScale;
    
    // Cone shape + noise
    let baseH = -depth * Math.max(0, 1.0 - Math.pow(t, 2.0));
    
    // Add cragginess
    const crag = fbm(x * 0.4, y * 0.4, z * 0.4, 3) * (R * 0.2);
    
    // Taper crag near edges
    baseH += crag * Math.max(0, 1.0 - t);
    
    // If outside limit, force clamp to 0 (water level) to meet top
    if (t > 1.0) {
        // Taper quickly to 0
        const falloff = 1.0 - Math.min((t - 1.0) * 5.0, 1.0);
        baseH *= falloff;
    }

    return baseH;
}

export function calculateIslandHeight(x, y, z, R, seed = 0, sizeScale = 1.0) {
    const theta = Math.atan2(z, x);
    const currentR = Math.sqrt(x*x + z*z);
    const coastLimit = getCoastLimit(theta, R, seed, sizeScale);
    
    // Normalize radial distance
    const rNorm = currentR / coastLimit;
    
    if (rNorm >= 1.0) {
        // Underwater slope
        // Fall off gently
        const slope = (rNorm - 1.0) * (R * 0.5);
        return -slope; // Negative height (underwater)
    }
    
    // Inland Generation
    // Height increases towards center but with variation
    const centerFactor = 1.0 - Math.pow(rNorm, 2.0); // Parabolic rise
    
    // Base Plateau Height
    const maxH = R * 0.25 * sizeScale;
    
    // Terrain Noise
    const terrain = fbm(x * 0.5 + seed, y * 0.5, z * 0.5, 4, 2.0, 0.4);
    
    // Mountains logic: amplify noise in center
    const mountainMask = Math.max(0, centerFactor - 0.2);
    const mountains = Math.max(0, fbm(x*0.8 + seed + 50, z*0.8, y*0.8, 3)) * R * 0.4;
    
    let h = (centerFactor * maxH * 0.5) + (terrain * R * 0.1) + (mountains * mountainMask);
    
    // River Generation
    const riverNoise = noise3D(x * 0.2 + seed, z * 0.2, seed * 2);
    // River path is where noise is close to 0
    const riverVal = Math.abs(riverNoise);
    const riverWidth = 0.05 * sizeScale;
    
    if (riverVal < riverWidth) {
        // Dig river
        const depth = (riverWidth - riverVal) / riverWidth; // 0 to 1
        h -= depth * R * 0.08;
        // Flatten to water level if deep enough
        if (h < 0.01 * R) h = -0.01 * R; 
    }
    
    // Ensure beaches are flat-ish near water
    if (h > 0 && h < 0.05 * R) {
        h *= 0.6; // Flatten low areas
    }

    return h;
}

export function createIslandMesh(radius, seed = 0, sizeScale = 1.0) {
    // High resolution mesh for detail
    const widthSegs = 200;
    const heightSegs = 200;
    
    const geometry = new THREE.SphereGeometry(
        radius, 
        widthSegs, 
        heightSegs, 
        0, Math.PI * 2, 
        0, ISLAND_ANGULAR_RADIUS * 2.0 
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
    const cSnow = new THREE.Color(0xffffff);      // White
    const cUnderRock = new THREE.Color(0x333333); // Dark Grey

    const v = new THREE.Vector3();

    for (let i = 0; i < count; i++) {
        let x = posAttribute.getX(i);
        let y = posAttribute.getY(i);
        let z = posAttribute.getZ(i);

        // Determine polar position
        const row = Math.floor(i / (widthSegs + 1));
        // phi goes from 0 (top) to 2*ANGULAR_RADIUS (bottom)
        const phi = (row / heightSegs) * (ISLAND_ANGULAR_RADIUS * 2.0);
        
        let isBottom = phi > ISLAND_ANGULAR_RADIUS;
        let hOffset = 0;
        
        // Handle bottom vertex singularity
        if (row === heightSegs) {
            x = 0; z = 0; y = -radius;
            isBottom = true;
        }

        if (!isBottom) {
            hOffset = calculateIslandHeight(x, y, z, radius, seed, sizeScale);
        } else {
            hOffset = calculateIslandBottomHeight(x, y, z, radius, phi, ISLAND_ANGULAR_RADIUS, seed, sizeScale);
        }
        
        // Apply height
        v.set(x, y, z).normalize().multiplyScalar(radius + hOffset);
        posAttribute.setXYZ(i, v.x, v.y, v.z);
        
        // --- Biome Coloring ---
        let c = new THREE.Color();
        const hRel = hOffset / radius; // Normalized height relative to radius
        
        if (isBottom || hRel < -0.05) {
            // Underside or deep water
            c.copy(cUnderRock);
            // Add rocky noise
            const rockNoise = noise3D(x, y, z);
            c.offsetHSL(0, 0, rockNoise * 0.1);
        } else if (hRel < 0.0) {
             // Shallow water / Coast
             // Blend sand into water
             c.copy(cWetSand).lerp(cDeepWater, Math.abs(hRel) * 20.0);
        } else {
            // Land Biomes
            // 1. Moisture Map
            const moisture = fbm(x * 0.2 + seed, y * 0.2, z * 0.2, 2) + 0.5; // 0 to 1 approx
            // 2. Temperature/Detail Map
            const temp = noise3D(x * 0.5 - seed, z * 0.5, seed);

            if (hRel < 0.05) {
                // Beach
                c.copy(cSand);
                if (moisture > 0.6) c.lerp(cGrass, 0.3); // Grassy dunes
                // Sand grain
                c.offsetHSL(0, 0, (Math.random()-0.5)*0.05);
            } else if (hRel < 0.25) {
                // Plains / Forest
                if (moisture < 0.35) {
                    c.copy(cDryGrass);
                } else if (moisture < 0.65) {
                    c.copy(cGrass);
                } else {
                    c.copy(cForest);
                }
                
                // Texture
                const grassTex = noise3D(x*10, z*10, seed);
                c.offsetHSL(0, 0, grassTex * 0.03);
                
            } else if (hRel < 0.5) {
                // High Altitude / Mountain Base
                c.copy(cRock);
                c.lerp(cGrass, 0.3); // Mossy rock
            } else {
                // Peaks
                c.copy(cSnow);
                c.lerp(cRock, 0.2);
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