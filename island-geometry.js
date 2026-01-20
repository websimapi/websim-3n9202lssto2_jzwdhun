import * as THREE from 'three';
import { noise3D } from './math-utils.js';

export const ISLAND_ANGULAR_RADIUS = Math.PI / 2.5; // ~72 degrees for more expansive island

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

// Helper to get height offset for the rocky underside of the island
export function calculateIslandBottomHeight(x, y, z, R, phi, maxPhi, seed = 0) {
    // Phi ranges from maxPhi to maxPhi * 2 for the bottom
    // t: 0 at the coast, 1 at the bottom center point
    const t = (phi - maxPhi) / maxPhi;

    // Deep jagged stalactite look
    // Use a power curve for the main volume to keep it thick near the top but pointy at bottom
    let baseH = -Math.pow(t, 0.8) * (R * 0.9); 

    // Dynamic Jagged Detail:
    const sx = x + seed;
    const sy = y + seed;
    const sz = z + seed;

    // 1. Large chunky blocky noise for main irregularities
    const chunks = fbm(sx * 0.5, sy * 0.5, sz * 0.5, 2) * (R * 0.25);
    
    // 2. Sharp ridges
    const ridgeNoise = 1.0 - Math.abs(fbm(sx * 1.2, sy * 1.2, sz * 1.2, 3));
    const sharpEdges = ridgeNoise * (R * 0.15);

    // Mask noise so it doesn't disrupt the smooth waterline at the coast (t=0)
    // Also taper noise at the very tip (t=1) slightly to avoid messy geometry intersection
    const noiseMask = THREE.MathUtils.smoothstep(t, 0.0, 0.2) * (1.0 - THREE.MathUtils.smoothstep(t, 0.9, 1.0));
    
    return baseH + (chunks + sharpEdges) * noiseMask;
}

export function calculateIslandHeight(x, y, z, R, seed = 0) {
    const sx = x + seed;
    const sy = y + seed;
    const sz = z + seed;

    // 1. Domain Warping for Organic Shape
    const warpFreq = 0.6;
    const warpAmp = R * 0.3; // High amplitude for irregular bays/peninsulas
    
    const dx = fbm(sx * warpFreq, sy * warpFreq, sz * warpFreq + 10.0, 2);
    const dz = fbm(sx * warpFreq, sy * warpFreq, sz * warpFreq + 20.0, 2);
    
    const wx = x + dx * warpAmp;
    const wz = z + dz * warpAmp;
    
    // Use distorted coordinates for radius check
    const dist = Math.sqrt(wx*wx + wz*wz);
    const landRadius = R * 0.8;
    
    // 2. River Generation
    // Rivers appear where noise value is close to 0 (worm-like channels)
    const riverFreq = 0.3;
    // Offset seed significantly for rivers so they don't align with terrain features predictably
    const rVal = fbm(sx * riverFreq + 50, sy * riverFreq + 50, sz * riverFreq + 50, 2);
    const riverWidth = 0.06;
    // 1.0 inside river, 0.0 outside
    const riverMask = 1.0 - THREE.MathUtils.smoothstep(0.0, riverWidth, Math.abs(rVal));
    
    // 3. Radial Gradient (The main shape)
    let radial = 1.0 - (dist / landRadius);
    
    // 4. Height Profile
    let h = 0;
    const plateauHeightVal = 0.06 * R; // Higher plateau
    
    if (radial > 0) {
        // Land Mass
        let landProfile = THREE.MathUtils.smoothstep(radial, 0.0, 0.3) * plateauHeightVal;
        
        // Add Hills
        const hillNoise = fbm(wx * 0.6, sy * 0.6, wz * 0.6, 3);
        landProfile += Math.max(0, hillNoise) * 0.08 * R;
        
        // Apply River
        // River creates a depression down to sea level (0) or slightly below
        // We modulate the depth so it doesn't cut through the beach too harshly
        if (riverMask > 0.01) {
            // River bed height (slightly underwater)
            const riverBed = -0.01 * R;
            h = THREE.MathUtils.lerp(landProfile, riverBed, riverMask);
        } else {
            h = landProfile;
        }

    } else {
         // Underwater slope
         h = radial * 1.5 * R; // Steep dropoff
    }
    
    return h;
}

export function createIslandMesh(radius, seed = 0) {
    // High resolution mesh
    const widthSegs = 256;
    const heightSegs = 256;
    
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
    
    // Colors
    const cDeepSand = new THREE.Color(0xcc9966);
    const cBeach = new THREE.Color(0xffcc88);
    const cGrass = new THREE.Color(0x55aa55);
    const cForest = new THREE.Color(0x227722);
    const cRock = new THREE.Color(0x444444);
    const cDeepRock = new THREE.Color(0x1a1a1a);
    const cRiverBed = new THREE.Color(0x8B4513); // Muddy river bottom

    const v = new THREE.Vector3();

    for (let i = 0; i < count; i++) {
        let x = posAttribute.getX(i);
        let y = posAttribute.getY(i);
        let z = posAttribute.getZ(i);

        // Calculate current phi to distinguish top from bottom
        const row = Math.floor(i / (widthSegs + 1));
        const phi = (row / heightSegs) * (ISLAND_ANGULAR_RADIUS * 2.0);
        
        let hOffset = 0;
        let isBottom = phi > ISLAND_ANGULAR_RADIUS;
        
        // Fix for closing the bottom mesh
        // If this is the last row, force vertices to a single point at the tip
        // We stretch the geometry to 180 deg effectively
        if (row === heightSegs) {
            x = 0;
            z = 0;
            y = -radius; // Placeholder, will be displaced
            isBottom = true;
        }

        // Use a temp vector for noise calculations to avoid 0,0,0 issues if needed
        // but passing 0,0,0 to noise is fine.
        
        if (!isBottom) {
            hOffset = calculateIslandHeight(x, y, z, radius, seed);
        } else {
            hOffset = calculateIslandBottomHeight(x, y, z, radius, phi, ISLAND_ANGULAR_RADIUS, seed);
        }
        
        // Final Position
        // For the tip (row === heightSegs), x/z are 0. vector is (0, -1, 0).
        // hOffset for bottom is negative. 
        // We set length to R + hOffset.
        v.set(x, y, z).normalize().multiplyScalar(radius + hOffset);
        posAttribute.setXYZ(i, v.x, v.y, v.z);
        
        // Coloring Logic
        let c = new THREE.Color();
        const hNorm = hOffset / radius;
        
        if (!isBottom) {
            if (hNorm < -0.005) {
                // River Bed / Deep Underwater
                c.copy(cRiverBed);
                // Darken slightly
                c.multiplyScalar(0.8);
            } else if (hNorm < 0.005) {
                // Waterline / Wet Sand
                c.copy(cDeepSand);
                c.lerp(cBeach, THREE.MathUtils.smoothstep(hNorm, -0.002, 0.005));
            } else if (hNorm < 0.03) {
                // Beach
                c.copy(cBeach);
                const sandVar = noise3D(x*3 + seed, y*3, z*3);
                c.offsetHSL(0, 0, sandVar * 0.02);
                c.lerp(cGrass, THREE.MathUtils.smoothstep(hNorm, 0.02, 0.03));
            } else {
                // Land
                c.copy(cGrass);
                const noiseVar = noise3D(x*0.4 + seed, y*0.4, z*0.4);
                c.offsetHSL(0, 0, noiseVar * 0.04);
                if (noiseVar > 0.4) c.lerp(cForest, 0.6);
            }
        } else {
            // Bottom Rock Colors
            const bottomProgress = (phi - ISLAND_ANGULAR_RADIUS) / ISLAND_ANGULAR_RADIUS;
            c.copy(cRock);
            c.lerp(cDeepRock, THREE.MathUtils.smoothstep(bottomProgress, 0.0, 1.0));
            // Add rocky texture variation
            const rVar = noise3D(x * 0.8 + seed, y * 0.8, z * 0.8);
            c.offsetHSL(0, 0, rVar * 0.05);
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