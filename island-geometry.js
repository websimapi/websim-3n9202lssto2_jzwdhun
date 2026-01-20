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
    
    // Normalize radial distance (0 at center, 1 at edge)
    const rNorm = currentR / coastLimit;
    
    if (rNorm >= 1.0) {
        // Underwater slope - gentle falloff
        const slope = (rNorm - 1.0) * (R * 0.3);
        return -slope; 
    }
    
    // Distance from coast (0 at edge, 1 at center)
    const d = 1.0 - rNorm;
    
    // Profile: Expansive Beach -> Cliff/Slope -> Flat Plateau
    const beachWidth = 0.35; // Wider beach
    
    // 1. Beach Rise (Very gentle)
    let h = 0;
    if (d < beachWidth) {
        // Linear gentle rise
        h = (d / beachWidth) * (R * 0.03);
    } else {
        // 2. Plateau Rise
        const hBeachTop = R * 0.03;
        const plateauHeight = R * 0.15 * sizeScale; // Flatter plateau
        const riseWidth = 0.15; // Width of slope to plateau
        
        const t = Math.min(1.0, (d - beachWidth) / riseWidth);
        const smoothT = t * t * (3 - 2 * t);
        
        h = hBeachTop + smoothT * plateauHeight;
    }
    
    // 3. Noise (Reduced for smoothness/pathing)
    const terrain = fbm(x * 0.25 + seed, y * 0.25, z * 0.25, 3, 2.0, 0.5);
    h += terrain * (R * 0.02); 
    
    // 4. River Generation
    const riverNoise = noise3D(x * 0.15 + seed, z * 0.15, seed * 2);
    const riverVal = Math.abs(riverNoise);
    const riverWidth = 0.07 * sizeScale;
    
    if (riverVal < riverWidth) {
        const depth = (riverWidth - riverVal) / riverWidth;
        const dig = depth * depth * (3 - 2 * depth);
        h -= dig * (R * 0.06);
        if (h < -0.005 * R) h = -0.005 * R; 
    }
    
    // Smoothing at water edge
    if (d < 0.05 && h > 0) {
        h *= THREE.MathUtils.smoothstep(d, 0.0, 0.05);
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
        
        if (isBottom || hRel < -0.02) {
            // Underside or deep water
            c.copy(cUnderRock);
            const rockNoise = noise3D(x, y, z);
            c.offsetHSL(0, 0, rockNoise * 0.1);
        } else if (hRel < 0.005) {
             // Shallow water / Wet Sand
             c.copy(cWetSand).lerp(cDeepWater, Math.abs(hRel) * 50.0);
        } else {
            // Land Biomes
            const moisture = fbm(x * 0.2 + seed, y * 0.2, z * 0.2, 2) + 0.5;
            
            // Adjust thresholds for flatter terrain
            // Beach ends approx 0.03
            // Plateau starts approx 0.03-0.08
            
            if (hRel < 0.04) {
                // Expansive Beach
                c.copy(cSand);
                if (moisture > 0.65) c.lerp(cGrass, 0.2); // Grassy dunes edge
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
                // Rocky Outcrops (rare now)
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