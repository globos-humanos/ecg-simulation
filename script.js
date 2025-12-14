
/* 
 * ECG Simulator Engine
 * Supports standard P-Q-R-S-T synthesis, irregular rhythms, and Lead transformations.
 */

class ECGSimulator {
    constructor(canvas, id) {
        this.id = id;
        this.canvas = canvas;
        this.ctx = this.canvas.getContext('2d');
        
        // --- State ---
        this.bpm = 60;
        this.targetBpm = 60; 
        this.noiseLevel = 0.05;
        this.lead = 'II';
        
        // View State
        this.isPaused = false;
        this.paperSpeed = 25; // 25mm/s or 50mm/s
        this.showLabels = false; // Analyze mode
        this.zoomLevel = 1.0; // Amplitude scaling
        
        // --- Wave Parameters ---
        this.baseParams = {
            p: { a: 0.15, t: -0.2, w: 0.04 }, 
            q: { a: -0.15, t: -0.05, w: 0.02 },
            r: { a: 1.0, t: 0.0, w: 0.025 },
            s: { a: -0.25, t: 0.05, w: 0.03 },
            j: { a: 0.0, t: 0.08, w: 0.01 }, 
            st: { a: 0.0, t: 0.15, w: 0.05 },
            t: { a: 0.3, t: 0.3, w: 0.08 }
        };

        this.currentParams = JSON.parse(JSON.stringify(this.baseParams));
        
        this.rhythmType = 'SINUS';
        this.beatQueue = []; 
        this.pWaveQueue = []; 
        
        // Rendering State
        this.time = 0; 
        this.scanX = 0;
        this.timeAccumulator = 0; // For precise pixel stepping
        
        this.dataBuffer = new Array(2000).fill(null);
        this.waveMeta = [];
        
        this.lastFrameTime = performance.now();
        this.isActive = true;
        
        this.alertRegions = []; 

        // Caliper State
        this.isDragging = false;
        this.caliperStart = {x:0, y:0};
        this.caliperCurrent = {x:0, y:0};

        // Bind events for cleanup
        this.handleStartDrag = this.startDrag.bind(this);
        this.handleMoveDrag = this.moveDrag.bind(this);
        this.handleEndDrag = this.endDrag.bind(this);

        this.resize();
        this.initInteraction();
    }

    destroy() {
        this.isActive = false;
        // Cleanup Events
        this.canvas.removeEventListener('mousedown', this.handleStartDrag);
        this.canvas.removeEventListener('mousemove', this.handleMoveDrag);
        window.removeEventListener('mouseup', this.handleEndDrag);
        
        this.canvas.removeEventListener('touchstart', this.handleStartDrag);
        this.canvas.removeEventListener('touchmove', this.handleMoveDrag);
        window.removeEventListener('touchend', this.handleEndDrag);
    }

    resize() {
        const rect = this.canvas.getBoundingClientRect();
        this.canvas.width = rect.width;
        this.canvas.height = rect.height;
        this.dataBuffer = new Array(this.canvas.width).fill({y: this.getBaselineY(), isAlert: false});
        this.scanX = 0;
    }
    
    initInteraction() {
        this.canvas.addEventListener('mousedown', this.handleStartDrag);
        this.canvas.addEventListener('mousemove', this.handleMoveDrag);
        window.addEventListener('mouseup', this.handleEndDrag); 
        
        this.canvas.addEventListener('touchstart', this.handleStartDrag);
        this.canvas.addEventListener('touchmove', this.handleMoveDrag);
        window.addEventListener('touchend', this.handleEndDrag);
    }
    
    startDrag(e) {
        if (!this.isPaused) return;
        const rect = this.canvas.getBoundingClientRect();
        const clientX = e.clientX || e.touches[0].clientX;
        const clientY = e.clientY || e.touches[0].clientY;
        
        this.isDragging = true;
        this.caliperStart = { x: clientX - rect.left, y: clientY - rect.top };
        this.caliperCurrent = { ...this.caliperStart };
    }
    
    moveDrag(e) {
        if (!this.isDragging) return;
        const rect = this.canvas.getBoundingClientRect();
        const clientX = e.clientX || e.touches[0].clientX;
        const clientY = e.clientY || e.touches[0].clientY;
        
        this.caliperCurrent = { x: clientX - rect.left, y: clientY - rect.top };
    }
    
    endDrag() {
        this.isDragging = false;
    }

    getBaselineY() {
        return this.canvas.height / 2;
    }
    
    getPxPerSec() {
        // 25mm/s -> 100px/s (approx 1s on screen)
        // 50mm/s -> 200px/s
        return this.paperSpeed === 50 ? 200 : 100;
    }
    
    getScaleY() {
        // Base Amplitude: 1.0mV = 25% of height
        // Scaled by Zoom Level
        return (this.canvas.height * 0.25) * this.zoomLevel;
    }

    // --- Physics / Math ---

    triggerShock() {
        this.setCondition('normal');
        this.beatQueue = [];
        this.pWaveQueue = [];
        this.waveMeta = [];
    }

    updateBeatQueue(currentTime) {
        if (this.externalBeatQueue) {
             this.beatQueue = this.externalBeatQueue;
             return;
        }
        
        const lookahead = 2.0;
        
        if (this.beatQueue.length === 0) {
            this.beatQueue.push(currentTime); 
            this.pushWaveMeta(currentTime);
        }

        while (this.beatQueue[this.beatQueue.length - 1] < currentTime + lookahead) {
            const lastBeat = this.beatQueue[this.beatQueue.length - 1];
            let interval = 60 / this.bpm;
            
            if (this.rhythmType === 'AFIB') {
                interval = interval * (0.5 + Math.random()); 
            }
            
            let nextBeat = lastBeat + interval;

            if (this.rhythmType === 'BLOCK2' && Math.random() < 0.25) {
                nextBeat += interval; 
            }

            this.beatQueue.push(nextBeat);
            this.pushWaveMeta(nextBeat);
        }

        // Cleanup
        if (this.beatQueue.length > 0 && this.beatQueue[0] < currentTime - 4.0) {
            this.beatQueue.shift();
        }
        
        // P-Wave Queue (Block 3)
        // Independent Atrial Rhythm
        if (this.rhythmType === 'BLOCK3') {
             const pRate = 75; // Typical sinus rate
             const pInterval = 60 / pRate;
             
             if (this.pWaveQueue.length === 0) {
                 this.pWaveQueue.push(currentTime);
                 this.waveMeta.push({ type: 'P', time: currentTime });
             }
             
             while (this.pWaveQueue[this.pWaveQueue.length - 1] < currentTime + lookahead) {
                 const nextP = this.pWaveQueue[this.pWaveQueue.length - 1] + pInterval;
                 this.pWaveQueue.push(nextP);
                 this.waveMeta.push({ type: 'P', time: nextP });
             }
             
             if (this.pWaveQueue.length > 0 && this.pWaveQueue[0] < currentTime - 4.0) {
                 this.pWaveQueue.shift();
             }
        } else {
             this.pWaveQueue = [];
        }

        // Cleanup Metadata
        this.waveMeta = this.waveMeta.filter(m => m.time > currentTime - 5.0);
    }
    
    pushWaveMeta(beatTime) {
        // Push theoretical P, Q, R, S, T times for this beat
        const p = this.currentParams;
        
        // Only add P wave if NOT Block 3 (handled separately) and NOT AFib/Flutter/VT
        if (this.rhythmType === 'SINUS' || this.rhythmType === 'BLOCK2' || this.rhythmType === 'avblock1') {
             this.waveMeta.push({ type: 'P', time: beatTime + p.p.t });
        }
        
        if (this.rhythmType !== 'VF') {
             this.waveMeta.push({ type: 'Q', time: beatTime + p.q.t });
             this.waveMeta.push({ type: 'R', time: beatTime + p.r.t });
             this.waveMeta.push({ type: 'S', time: beatTime + p.s.t });
             this.waveMeta.push({ type: 'T', time: beatTime + p.t.t });
        }
    }

    getVoltageAndAlert(t) {
        let v = 0;
        let isAlert = false;
        
        const p = this.currentParams;

        // QRS / Ventricular Beats
        for (let beatTime of this.beatQueue) {
            const dt = t - beatTime;
            if (Math.abs(dt) > 1.0) continue;
            
            v += this.getBeatVoltage(dt);
            
            if (this.alertRegions.length > 0) {
                if (this.alertRegions.includes('pr') && dt > (p.p.t + 0.1) && dt < -0.05) isAlert = true;
                if (this.alertRegions.includes('st') && dt > 0.08 && dt < 0.25) isAlert = true;
                if (this.alertRegions.includes('qrs') && dt > -0.06 && dt < 0.06) isAlert = true;
                if (this.alertRegions.includes('qt') && dt > -0.05 && dt < (p.t.t + 0.1)) isAlert = true;
            }
        }
        
        // Independent P-Waves (Block 3)
        if (this.rhythmType === 'BLOCK3') {
            for (let pTime of this.pWaveQueue) {
                const dt = t - pTime;
                if (Math.abs(dt) > 1.0) continue;
                v += p.p.a * Math.exp(-Math.pow(dt, 2) / (2 * p.p.w * p.p.w));
            }
        }
        
        v += this.getBaselineArtifacts(t);
        return { v, isAlert };
    }

    getBeatVoltage(dt) {
        let v = 0;
        const p = this.currentParams;
        const gaussian = (x, a, center, w) => a * Math.exp(-Math.pow(x - center, 2) / (2 * w * w));

        // P Wave Logic
        if (this.rhythmType !== 'AFIB' && this.rhythmType !== 'FLUTTER' && this.rhythmType !== 'VT' && this.rhythmType !== 'VF' && this.rhythmType !== 'BLOCK3') {
            v += gaussian(dt, p.p.a, p.p.t, p.p.w);
        }
        
        if (this.rhythmType !== 'VF') {
            v += gaussian(dt, p.q.a, p.q.t, p.q.w);
            v += gaussian(dt, p.r.a, p.r.t, p.r.w);
            v += gaussian(dt, p.s.a, p.s.t, p.s.w);
        }
        if (p.st.a !== 0) {
             if (p.st.a > 0.2) {
                 v += gaussian(dt, p.st.a, p.st.t, p.st.w * 2.0); 
             } else {
                 v += gaussian(dt, p.st.a, p.st.t, p.st.w);
             }
        }
        if (this.rhythmType !== 'VF') {
            v += gaussian(dt, p.t.a, p.t.t, p.t.w);
        }
        return v;
    }
    
    getBaselineArtifacts(t) {
        let v = 0;
        if (this.rhythmType === 'TORSADES') {
            const fast = Math.sin(t * 25); 
            const slow = Math.sin(t * 3);  
            return fast * slow * 1.5; 
        }
        if (this.rhythmType === 'AFIB') {
            v += Math.sin(t * 45) * 0.05; 
            v += (Math.random() - 0.5) * 0.03;
        }
        if (this.rhythmType === 'FLUTTER') {
            const flutterFreq = 5.0 * (2 * Math.PI);
            v += Math.sin(t * flutterFreq) * 0.15;
            v += Math.sin(t * flutterFreq * 2) * 0.05; 
        }
        if (this.rhythmType === 'VF') {
             v += Math.sin(t * 20) * 0.3;
             v += Math.cos(t * 15) * 0.2;
        }
        if (this.noiseLevel > 0) {
            v += (Math.random() - 0.5) * this.noiseLevel;
        }
        return v;
    }
    
    applyLeadTransform(voltage) {
        let scale = 1.0;
        switch(this.lead) {
            case 'I': scale = 0.7; break;
            case 'II': scale = 1.0; break;
            case 'III': scale = 0.5; break;
            case 'aVR': scale = -0.8; break; 
            case 'aVL': scale = 0.4; break;
            case 'aVF': scale = 0.9; break;
            case 'V1': scale = -0.3; break; 
            case 'V2': scale = 0.2; break;
            case 'V3': scale = 0.8; break; 
            case 'V4': scale = 1.1; break;
            case 'V5': scale = 1.0; break;
            case 'V6': scale = 0.8; break;
        }
        return voltage * scale;
    }

    loop(t) {
        if (!this.isActive) return;

        const dt = Math.min((t - this.lastFrameTime) / 1000, 0.1);
        this.lastFrameTime = t;
        
        if (!this.isPaused) {
            this.update(dt);
        }
        this.draw();
        
        requestAnimationFrame((t) => this.loop(t));
    }

    start() {
        this.lastFrameTime = performance.now();
        requestAnimationFrame((t) => this.loop(t));
    }

    update(dt) {
        // Accumulate real time
        this.timeAccumulator += dt;
        
        const pxPerSec = this.getPxPerSec();
        
        // Calculate exact pixel steps
        const pixelsToDraw = Math.floor(this.timeAccumulator * pxPerSec);
        
        if (pixelsToDraw > 0) {
            const timeStep = pixelsToDraw / pxPerSec;
            this.timeAccumulator -= timeStep;
            
            for (let i = 0; i < pixelsToDraw; i++) {
                this.time += (1 / pxPerSec);
                
                const result = this.getVoltageAndAlert(this.time);
                let v = result.v;
                
                v = this.applyLeadTransform(v);
                
                // Map to Y with Zoom
                const scaleY = this.getScaleY(); 
                const y = this.getBaselineY() - (v * scaleY);
                
                this.dataBuffer[this.scanX] = { y: y, isAlert: result.isAlert, time: this.time };
                
                this.scanX++;
                if (this.scanX >= this.canvas.width) {
                    this.scanX = 0;
                }
            }
        }
        
        if (this.bpm !== this.targetBpm) {
            const diff = this.targetBpm - this.bpm;
            if (Math.abs(diff) < 1) this.bpm = this.targetBpm;
            else this.bpm += diff * dt * 2.0;
        }

        this.updateBeatQueue(this.time + this.timeAccumulator); 
    }

    draw() {
        this.ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--monitor-bg');
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

        this.drawGrid();

        this.ctx.lineWidth = 2;
        this.ctx.lineJoin = 'round';
        
        const normalColor = getComputedStyle(document.documentElement).getPropertyValue('--ecg-trace');
        const alertColor = getComputedStyle(document.documentElement).getPropertyValue('--ecg-trace-alert');
        
        const gap = 40;
        
        this.ctx.beginPath();
        this.ctx.strokeStyle = normalColor;
        let drawing = false;
        let currentColor = normalColor;

        for (let x = 0; x < this.canvas.width; x++) {
             if (x >= this.scanX && x < this.scanX + gap) {
                 if (drawing) { this.ctx.stroke(); drawing = false; }
                 continue;
             }
             
             const data = this.dataBuffer[x];
             if (!data) continue;
             
             const pointColor = data.isAlert ? alertColor : normalColor;
             
             if (drawing && pointColor !== currentColor) {
                 this.ctx.stroke();
                 this.ctx.beginPath();
                 this.ctx.strokeStyle = pointColor;
                 currentColor = pointColor;
                 const prev = this.dataBuffer[x-1];
                 if(prev) this.ctx.moveTo(x-1, prev.y);
             }
             
             if (!drawing || x === this.scanX + gap) {
                 this.ctx.beginPath();
                 this.ctx.strokeStyle = pointColor;
                 currentColor = pointColor;
                 this.ctx.moveTo(x, data.y);
                 drawing = true;
             } else {
                 this.ctx.lineTo(x, data.y);
             }
        }
        if (drawing) this.ctx.stroke();
        
        // --- OVERLAYS ---
        
        if (this.showLabels) {
            this.drawLabels();
        }
        
        if (this.isPaused && this.isDragging) {
            this.drawCalipers();
        }
    }
    
    drawLabels() {
        this.ctx.fillStyle = '#fff';
        this.ctx.font = '10px sans-serif';
        this.ctx.textAlign = 'center';
        
        const pxPerSec = this.getPxPerSec();
        const bottomY = this.canvas.height * 0.9;
        
        for (let meta of this.waveMeta) {
            const timeDiff = this.time - meta.time;
            if (timeDiff < 0) continue; 
            
            const pxDiff = timeDiff * pxPerSec;
            if (pxDiff > this.canvas.width) continue; 
            
            let x = this.scanX - pxDiff;
            if (x < 0) x += this.canvas.width;
            
            if (x >= this.scanX && x < this.scanX + 40) continue; 
            
            this.ctx.fillText(meta.type, x, bottomY);
            
            this.ctx.strokeStyle = 'rgba(255,255,255,0.2)';
            this.ctx.setLineDash([2, 2]);
            this.ctx.beginPath();
            this.ctx.moveTo(x, bottomY - 10);
            this.ctx.lineTo(x, this.canvas.height * 0.1); 
            this.ctx.stroke();
            this.ctx.setLineDash([]);
        }
    }
    
    drawCalipers() {
        const x1 = this.caliperStart.x;
        const x2 = this.caliperCurrent.x;
        const y1 = this.caliperStart.y;
        const y2 = this.caliperCurrent.y;
        
        this.ctx.strokeStyle = '#f1c40f';
        this.ctx.lineWidth = 1;
        this.ctx.setLineDash([5, 3]);
        
        // Vertical lines
        this.ctx.beginPath();
        this.ctx.moveTo(x1, 0); this.ctx.lineTo(x1, this.canvas.height);
        this.ctx.stroke();
        
        this.ctx.beginPath();
        this.ctx.moveTo(x2, 0); this.ctx.lineTo(x2, this.canvas.height);
        this.ctx.stroke();
        
        this.ctx.setLineDash([]);
        
        // Horizontal Arrow
        const midY = (y1 + y2) / 2;
        this.ctx.beginPath();
        this.ctx.moveTo(x1, midY); this.ctx.lineTo(x2, midY);
        this.ctx.stroke();
        
        // Math
        const pxPerSec = this.getPxPerSec();
        const dt = Math.abs(x2 - x1) / pxPerSec; 
        const ms = Math.round(dt * 1000);
        
        // Adjust Voltage Calc for Zoom
        const scaleY = this.getScaleY(); 
        const dv = Math.abs(y2 - y1) / scaleY; 
        const mv = dv.toFixed(2);
        
        // Text Box
        const text = `${ms} ms | ${mv} mV`;
        const tx = Math.min(x1, x2) + Math.abs(x2 - x1)/2;
        const ty = midY - 10;
        
        this.ctx.fillStyle = 'rgba(0,0,0,0.8)';
        this.ctx.fillRect(tx - 50, ty - 15, 100, 20);
        this.ctx.strokeStyle = '#f1c40f';
        this.ctx.strokeRect(tx - 50, ty - 15, 100, 20);
        
        this.ctx.fillStyle = '#f1c40f';
        this.ctx.textAlign = 'center';
        this.ctx.fillText(text, tx, ty - 2);
    }

    drawGrid() {
        this.ctx.lineWidth = 1;
        this.ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--monitor-grid-minor');
        
        const gridSize = 20;
        this.ctx.beginPath();
        for (let x = 0; x < this.canvas.width; x += gridSize) {
            this.ctx.moveTo(x, 0); this.ctx.lineTo(x, this.canvas.height);
        }
        for (let y = 0; y < this.canvas.height; y += gridSize) {
            this.ctx.moveTo(0, y); this.ctx.lineTo(this.canvas.width, y);
        }
        this.ctx.stroke();
        
        this.ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--monitor-grid-major');
        this.ctx.beginPath();
        for (let x = 0; x < this.canvas.width; x += gridSize * 5) {
            this.ctx.moveTo(x, 0); this.ctx.lineTo(x, this.canvas.height);
        }
        for (let y = 0; y < this.canvas.height; y += gridSize * 5) {
            this.ctx.moveTo(0, y); this.ctx.lineTo(this.canvas.width, y);
        }
        this.ctx.stroke();
    }
    
    // --- Public API ---
    setCondition(conditionId) {
        this.activeConditionId = conditionId; 
        this.rhythmType = 'SINUS';
        this.noiseLevel = 0.05;
        this.pWaveQueue = [];
        this.alertRegions = [];
        this.waveMeta = [];
        
        let p = JSON.parse(JSON.stringify(this.baseParams));
        
        const condition = CONDITIONS[conditionId];
        if (!condition) {
            this.currentParams = p;
            return;
        }

        if (condition.bpm) this.targetBpm = condition.bpm;
        if (condition.rhythm) this.rhythmType = condition.rhythm;
        
        if (condition.params) {
            for (let wave in condition.params) {
                for (let prop in condition.params[wave]) {
                    p[wave][prop] = condition.params[wave][prop];
                }
            }
        }
        
        let leadMatches = false;
        
        if (condition.stElevationLeads) {
            if (condition.stElevationLeads.includes(this.lead)) {
                p.st.a = 0.5; 
                p.t.a = 0.4; 
                p.st.w = 0.12; 
                p.st.t = 0.1;
                leadMatches = true;
                this.alertRegions.push('st'); 
            }
        }
        
        if (condition.stDepressionLeads) {
            if (condition.stDepressionLeads.includes(this.lead)) {
                p.st.a = -0.2; 
                p.t.a = -0.1; 
                leadMatches = true;
                this.alertRegions.push('st');
            }
        }
        
        if (condition.alertRegions) {
            const isLocal = condition.stElevationLeads || condition.stDepressionLeads;
            if (!isLocal || leadMatches) {
                 condition.alertRegions.forEach(r => {
                     if (!this.alertRegions.includes(r)) this.alertRegions.push(r);
                 });
            }
        }

        this.currentParams = p;
    }
    
    togglePause() { this.isPaused = !this.isPaused; }
    toggleSpeed() { this.paperSpeed = this.paperSpeed === 25 ? 50 : 25; }
    toggleLabels() { this.showLabels = !this.showLabels; }
    setZoom(val) { this.zoomLevel = val; }
}

// --- Manager ---
class AppManager {
    constructor() {
        this.grid = document.getElementById('monitorGrid');
        this.simulators = [];
        this.selectedSimIndex = 0;
        this.layout = '1'; 
        this.masterBeatQueue = []; 
        
        this.init();
    }

    init() {
        // Layouts
        document.querySelectorAll('.view-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.view-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.setLayout(btn.dataset.layout);
            });
        });
        
        // Tools
        document.getElementById('btnFreeze').addEventListener('click', (e) => {
            e.target.classList.toggle('active');
            this.updateActiveSim(sim => sim.togglePause());
        });
        
        document.getElementById('btnSpeed').addEventListener('click', (e) => {
            // Check state
            const is50 = e.target.innerText.includes('50');
            if (is50) {
                 e.target.innerText = '⏩ 25mm/s';
                 e.target.classList.remove('active');
            } else {
                 e.target.innerText = '⏩ 50mm/s';
                 e.target.classList.add('active');
            }
            this.updateActiveSim(sim => sim.toggleSpeed());
        });
        
        document.getElementById('btnAnalyze').addEventListener('click', (e) => {
             e.target.classList.toggle('active');
             this.updateActiveSim(sim => sim.toggleLabels());
        });
        
        // Zoom Buttons
        document.querySelectorAll('button[data-zoom]').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('button[data-zoom]').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                const val = parseFloat(btn.dataset.zoom);
                this.updateActiveSim(sim => sim.setZoom(val));
            });
        });
        
        // Manual Controls
        document.getElementById('bpmSlider').addEventListener('input', (e) => {
            this.updateActiveSim(sim => {
                const val = parseInt(e.target.value);
                document.getElementById('bpmReadout').innerText = val;
                sim.targetBpm = val;
            });
        });
        
        document.getElementById('noiseSlider').addEventListener('input', (e) => {
            this.updateActiveSim(sim => {
                const val = parseInt(e.target.value);
                document.getElementById('noiseReadout').innerText = val + '%';
                sim.noiseLevel = val / 100;
            });
        });
        
        document.getElementById('leadSelector').addEventListener('change', (e) => {
            this.updateActiveSim(sim => {
                sim.lead = e.target.value;
                if (sim.activeConditionId) sim.setCondition(sim.activeConditionId);
                this.updateInfoBox(sim);
            });
        });
        
        // Action Buttons
        document.getElementById('btnShock').addEventListener('click', () => {
             this.updateActiveSim(sim => sim.triggerShock());
        });
        
        window.addEventListener('resize', () => {
            this.simulators.forEach(sim => sim.resize());
        });

        this.setLayout('1');
        this.buildMenu();
    }

    setLayout(layout) {
        this.layout = layout;
        this.grid.className = `monitor-grid grid-${layout}`;
        this.grid.innerHTML = '';
        
        this.simulators.forEach(s => s.destroy());
        this.simulators = [];
        
        const count = layout === '12' ? 12 : parseInt(layout);
        const leads12 = ['I','II','III','aVR','aVL','aVF','V1','V2','V3','V4','V5','V6'];
        
        for(let i=0; i<count; i++) {
            const frame = document.createElement('div');
            frame.className = 'monitor-frame';
            frame.onclick = () => this.selectSim(i);
            
            const cvs = document.createElement('canvas');
            frame.appendChild(cvs);
            
            const overlay = document.createElement('div');
            overlay.className = 'monitor-overlay';
            overlay.innerHTML = `
                <div class="vital-sign">
                    <span class="value bpm-display">60</span>
                </div>`;
            frame.appendChild(overlay);

            const label = document.createElement('div');
            label.className = 'monitor-label';
            label.innerText = layout === '12' ? leads12[i] : `Monitor ${i+1}`;
            frame.appendChild(label);
            
            this.grid.appendChild(frame);
            
            const sim = new ECGSimulator(cvs, i);
            
            if (layout === '12') {
                sim.lead = leads12[i];
                sim.externalBeatQueue = this.masterBeatQueue; 
            }
            
            sim.start();
            this.simulators.push(sim);
        }
        
        this.selectSim(0);

        const leadSel = document.getElementById('leadSelectorContainer');
        if (layout === '12') leadSel.style.display = 'none';
        else leadSel.style.display = 'block';
        
        if (layout === '12') this.startMasterClock();
    }

    startMasterClock() {
        const updateQueue = () => {
            if (this.layout !== '12') return;
            
            const masterSim = this.simulators[0];
            const now = masterSim.time;
            
            const lookahead = 2.0;
            if (this.masterBeatQueue.length === 0) {
                this.masterBeatQueue.push(now); 
            }

            while (this.masterBeatQueue[this.masterBeatQueue.length - 1] < now + lookahead) {
                const lastBeat = this.masterBeatQueue[this.masterBeatQueue.length - 1];
                let interval = 60 / masterSim.bpm;
                if (masterSim.rhythmType === 'AFIB') interval *= (0.5 + Math.random());
                this.masterBeatQueue.push(lastBeat + interval);
            }
             if (this.masterBeatQueue.length > 0 && this.masterBeatQueue[0] < now - 2.0) {
                this.masterBeatQueue.shift();
            }
            
            requestAnimationFrame(updateQueue);
        };
        updateQueue();
    }

    selectSim(index) {
        this.selectedSimIndex = index;
        document.querySelectorAll('.monitor-frame').forEach((el, i) => {
            if (i === index) el.classList.add('selected');
            else el.classList.remove('selected');
        });
        
        const sim = this.simulators[index];
        if (sim) {
            document.getElementById('bpmSlider').value = sim.targetBpm;
            document.getElementById('bpmReadout').innerText = sim.targetBpm;
            document.getElementById('noiseSlider').value = sim.noiseLevel * 100;
            document.getElementById('noiseReadout').innerText = (sim.noiseLevel * 100) + '%';
            document.getElementById('leadSelector').value = sim.lead;
            
            document.querySelectorAll('.condition-btn').forEach(b => {
               if (b.dataset.id === sim.activeConditionId) b.classList.add('active');
               else b.classList.remove('active');
            });

            this.updateInfoBox(sim);
            
            // Sync Tools State
            const btnFreeze = document.getElementById('btnFreeze');
            if (sim.isPaused) btnFreeze.classList.add('active'); else btnFreeze.classList.remove('active');
            
            const btnAnalyze = document.getElementById('btnAnalyze');
            if (sim.showLabels) btnAnalyze.classList.add('active'); else btnAnalyze.classList.remove('active');
            
            const btnSpeed = document.getElementById('btnSpeed');
            if (sim.paperSpeed === 50) {
                btnSpeed.innerText = '⏩ 50mm/s';
                btnSpeed.classList.add('active');
            } else {
                btnSpeed.innerText = '⏩ 25mm/s';
                btnSpeed.classList.remove('active');
            }
            
            // Sync Zoom Buttons
            document.querySelectorAll('button[data-zoom]').forEach(b => {
                if (parseFloat(b.dataset.zoom) === sim.zoomLevel) b.classList.add('active');
                else b.classList.remove('active');
            });
        }
    }

    updateActiveSim(callback) {
        if (this.layout === '12') {
            this.simulators.forEach(callback);
        } else {
            const sim = this.simulators[this.selectedSimIndex];
            if (sim) callback(sim);
        }
        this.selectSim(this.selectedSimIndex);
    }
    
    updateInfoBox(sim) {
        const condition = CONDITIONS[sim.activeConditionId] || CONDITIONS['normal'];
        const box = document.getElementById('infoBox');
        
        let visibilityNote = "";
        
        if (condition.stElevationLeads) {
            if (condition.stElevationLeads.includes(sim.lead)) {
                visibilityNote = `<span style="color:var(--ecg-trace-alert)">⚠️ <strong>VISIBLE:</strong> Significant ST Elevation detected in this lead.</span>`;
            } else {
                visibilityNote = `<span style="opacity:0.7">ℹ️ <strong>HIDDEN:</strong> Changes not typically seen in Lead ${sim.lead}. Switch to ${condition.stElevationLeads[0]} to view.</span>`;
            }
        }
        
        let html = `<h3>${condition.name}</h3>`;
        html += `<p>${condition.desc}</p>`;
        
        if (condition.detailedNote) {
             html += `<div style="margin-top:10px; font-size:0.9rem; border-left:2px solid var(--accent-color); padding-left:10px;">${condition.detailedNote}</div>`;
        }
        
        if (visibilityNote) {
            html += `<div style="margin-top:10px; font-size:0.85rem;">${visibilityNote}</div>`;
        }
        
        box.innerHTML = html;
    }

    buildMenu() {
        const menuContainer = document.getElementById('conditionsMenu');
        menuContainer.innerHTML = '';
        
        MENU_STRUCTURE.forEach(group => {
            const groupDiv = document.createElement('div');
            groupDiv.className = 'category-group';
            
            const btn = document.createElement('button');
            btn.className = 'category-btn';
            btn.innerText = group.cat;
            btn.onclick = () => {
                 document.querySelectorAll('.category-group').forEach(d => {
                     if(d !== groupDiv) d.classList.remove('open');
                 });
                 groupDiv.classList.toggle('open');
            };
            
            const content = document.createElement('div');
            content.className = 'category-content';
            
            group.items.forEach(itemId => {
                const data = CONDITIONS[itemId];
                const itemBtn = document.createElement('button');
                itemBtn.className = 'condition-btn';
                itemBtn.innerText = data.name;
                itemBtn.dataset.id = itemId;
                
                itemBtn.onclick = () => {
                    this.updateActiveSim(sim => sim.setCondition(itemId));
                };
                
                content.appendChild(itemBtn);
            });
            
            groupDiv.appendChild(btn);
            groupDiv.appendChild(content);
            menuContainer.appendChild(groupDiv);
        });
        document.querySelector('.category-group').classList.add('open');
    }
}

// --- Data ---
const CONDITIONS = {
    'normal': { 
        bpm: 60, rhythm: 'SINUS', name: 'Normal Sinus Rhythm', 
        desc: 'Healthy heart rhythm.', 
        detailedNote: 'Observe regular P-Q-R-S-T intervals. No ST deviation.'
    },
    'stemi_ant': { 
        bpm: 90, stElevationLeads: ['V1','V2','V3','V4'], 
        name: 'Anterior STEMI (LAD)', 
        desc: 'Acute occlusion of the Left Anterior Descending artery.',
        detailedNote: 'Look for <strong>ST Elevation</strong> (highlighted red) in precordial leads V1-V4. This pattern is often called "Tombstoneing".'
    },
    'stemi_inf': { 
        bpm: 80, stElevationLeads: ['II','III','aVF'], 
        name: 'Inferior STEMI (RCA)', 
        desc: 'Occlusion of the Right Coronary Artery.',
        detailedNote: 'ST Elevation is prominent in the inferior leads (II, III, aVF). Lead I and aVL may show reciprocal depression.'
    },
    'stemi_lat': { 
        bpm: 85, stElevationLeads: ['I','aVL','V5','V6'], 
        name: 'Lateral STEMI (LCx)', 
        desc: 'Occlusion of the Circumflex artery.',
        detailedNote: 'Elevation visible in lateral leads (I, aVL, V5, V6).'
    },
    'nstemi': { 
        bpm: 80, stDepressionLeads: ['V2','V3','V4','V5'], 
        name: 'NSTEMI / Ischemia', 
        desc: 'Subendocardial ischemia without full thickness necrosis.',
        detailedNote: 'Characterized by <strong>ST Depression</strong> and/or T-wave Inversion. Unlike STEMI, the artery is not completely blocked.'
    },
    
    'afib': { 
        bpm: 130, rhythm: 'AFIB', name: 'Atrial Fibrillation', 
        desc: 'Irregularly irregular rhythm.',
        detailedNote: 'Absence of distinct P-waves. Replaced by fine fibrillatory baseline tremors. Ventricular rate is rapid and chaotic.'
    },
    'aflutter': { 
        bpm: 150, rhythm: 'FLUTTER', name: 'Atrial Flutter', 
        desc: 'Macro-reentrant atrial circuit.',
        detailedNote: 'Classic "Saw-tooth" pattern (F-waves) best seen in Leads II and III. Rate is often fixed (e.g., 2:1 block).'
    },
    'vtach': { 
        bpm: 180, rhythm: 'VT', name: 'Ventricular Tachycardia', 
        desc: 'Wide QRS complex tachycardia.', 
        alertRegions: ['qrs'],
        params: { r: {w:0.08, a:1.2}, t:{a:0}, p:{a:0} },
        detailedNote: 'Broad QRS complexes (>120ms). P-waves are often dissociated and invisible.'
    },
    'vf': { 
        bpm: 0, rhythm: 'VF', name: 'Ventricular Fibrillation', 
        desc: 'Cardiac arrest.',
        detailedNote: 'Chaotic, disorganized electrical activity. No pulse. Immediate defibrillation required.'
    },
    'torsades': { 
        bpm: 0, rhythm: 'TORSADES', name: 'Torsades de Pointes', 
        desc: 'Polymorphic VT.',
        detailedNote: '"Twisting of the points". The QRS amplitude modulates around the isoelectric line.'
    },

    'block2': { 
        bpm: 60, rhythm: 'BLOCK2', name: '2nd Deg AV Block (Mobitz II)', 
        desc: 'Intermittent dropped beats.',
        detailedNote: 'Regular P-waves, but some QRS complexes are missing. The PR interval remains constant for conducted beats.'
    },
    'block3': { 
        bpm: 30, rhythm: 'BLOCK3', name: '3rd Deg AV Block (Complete)', 
        desc: 'Total AV Dissociation.',
        detailedNote: 'Atria (P) and Ventricles (QRS) beat independently. P-waves "march through" the rhythm strip regardless of QRS timing.'
    },
    'avblock1': { 
        bpm: 60, name: '1st Degree AV Block', 
        desc: 'Prolonged conduction.', 
        alertRegions: ['pr'],
        params: { p: {t: -0.3} }, 
        detailedNote: 'PR Interval is >200ms (one big square). Every P-wave is followed by a QRS.'
    }, 
    
    'lbbb': { 
        bpm: 70, name: 'Left Bundle Branch Block', 
        desc: 'Conduction delay in LBB.', 
        alertRegions: ['qrs'],
        params: { r: {w:0.06} },
        detailedNote: 'Wide QRS complex (>120ms). Broad, notched R-waves in lateral leads.'
    },
    'rbbb': { 
        bpm: 70, name: 'Right Bundle Branch Block', 
        desc: 'Conduction delay in RBB.', 
        alertRegions: ['qrs'],
        detailedNote: 'Wide QRS. "Rabbit Ears" (RSR\') pattern in V1.'
    },
    
    'hyperkalemia': { 
        bpm: 50, name: 'Hyperkalemia', 
        desc: 'High Potassium.', 
        alertRegions: ['qrs'], 
        params: { t: {a: 0.9, w:0.04}, r:{w:0.05} },
        detailedNote: 'Tall, "Peaked" T-waves. As it worsens, QRS widens.'
    },
    'hypokalemia': { 
        bpm: 65, name: 'Hypokalemia', 
        desc: 'Low Potassium.', 
        alertRegions: ['st'],
        params: { t: {a: 0.1}, st: {a: -0.1} },
        detailedNote: 'Flattened T-waves, ST depression, and prominent U-waves.'
    },
    'hypercalcemia': { 
        bpm: 60, name: 'Hypercalcemia', 
        desc: 'High Calcium.', 
        alertRegions: ['qt'],
        params: { st: {w:0.01}, t:{t:0.25} }, 
        detailedNote: 'Shortened QT interval.'
    }, 
    'hypocalcemia': { 
        bpm: 60, name: 'Hypocalcemia', 
        desc: 'Low Calcium.', 
        alertRegions: ['qt'],
        params: { st: {w:0.12}, t:{t:0.5} }, 
        detailedNote: 'Prolonged QT interval.'
    }, 

    'digoxin': { 
        bpm: 60, name: 'Digoxin Effect', 
        desc: 'Therapeutic effect.', 
        alertRegions: ['st'],
        params: { st: {a: -0.15, t: 0.1} },
        detailedNote: 'Scooped ST depression resembling a "Salvador Dali moustache".'
    },
    'quinidine': { 
        bpm: 60, name: 'Quinidine (Class Ia)', 
        desc: 'Anti-arrhythmic effect.', 
        alertRegions: ['qt'],
        params: { t: {t: 0.5, w: 0.1} },
        detailedNote: 'QT Prolongation and T-wave widening.'
    },
    'pericarditis': { 
        bpm: 90, name: 'Acute Pericarditis', 
        desc: 'Inflammation of pericardium.', 
        stElevationLeads: ['I','II','III','aVF','V2','V3','V4','V5','V6'],
        detailedNote: 'Diffuse ST elevation in almost all leads. PR segment depression is often present.'
    },
};

const MENU_STRUCTURE = [
    { cat: 'Ischemia / MI', items: ['normal', 'stemi_ant', 'stemi_inf', 'stemi_lat', 'nstemi'] },
    { cat: 'Arrhythmias', items: ['afib', 'aflutter', 'vtach', 'vf', 'torsades'] },
    { cat: 'Conduction Blocks', items: ['avblock1', 'block2', 'block3', 'lbbb', 'rbbb'] },
    { cat: 'Electrolytes', items: ['hyperkalemia', 'hypokalemia', 'hypercalcemia', 'hypocalcemia'] },
    { cat: 'Drugs & Toxins', items: ['digoxin', 'quinidine'] },
    { cat: 'Structural / Other', items: ['pericarditis'] }
];

document.addEventListener('DOMContentLoaded', () => {
    window.app = new AppManager();
});
