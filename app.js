// ============================================
// AirQ - Airport Security Tracker App v2
// Freemium + Safe Zone / Risk Zone + Spike Alerts
// ============================================

// --- State ---
let selectedAirport = null;
let selectedTerminal = 0; // index
let predictionInterval = null;
let liveUpdateInterval = null;
let refreshCountdown = 120; // seconds
let countdownInterval = null;
let previousWaitTimes = {}; // for trend detection

// --- All features are free ---
function isPro() {
    return true;
}

// --- Wait Time Engine ---

function getAirportLocalHour(airport) {
    try {
        const now = new Date();
        const formatter = new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: airport.timezone });
        return parseInt(formatter.format(now));
    } catch { return new Date().getHours(); }
}

function getAirportLocalMinute(airport) {
    try {
        const now = new Date();
        const formatter = new Intl.DateTimeFormat("en-US", { minute: "numeric", timeZone: airport.timezone });
        return parseInt(formatter.format(now));
    } catch { return new Date().getMinutes(); }
}

function getAirportLocalDow(airport) {
    try {
        const now = new Date();
        const formatter = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: airport.timezone });
        return formatter.format(now);
    } catch { return ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][new Date().getDay()]; }
}

function timeMultiplier(hour) {
    const curve = [
        0.3, 0.2, 0.15, 0.15, 0.25, 0.5,
        0.85, 1.0, 0.95, 0.8, 0.7, 0.65,
        0.6, 0.55, 0.5, 0.55, 0.75, 0.9,
        0.7, 0.5, 0.4, 0.35, 0.3, 0.25
    ];
    return curve[hour] || 0.5;
}

function dowMultiplier(dow) {
    const mults = { Sun: 1.1, Mon: 0.95, Tue: 0.75, Wed: 0.8, Thu: 0.9, Fri: 1.15, Sat: 0.85 };
    return mults[dow] || 1.0;
}

function sizeBase(size) {
    const bases = { mega: 28, large: 20, medium: 14, small: 8 };
    return bases[size] || 12;
}

function hashCode(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash) + str.charCodeAt(i);
        hash |= 0;
    }
    return Math.abs(hash);
}

function seededRandom(seed) {
    const x = Math.sin(seed) * 10000;
    return x - Math.floor(x);
}

// Generate wait times with terminal variation and spike simulation
function generateWaitTimes(airport, hourOverride, terminalIdx) {
    const hour = hourOverride !== undefined ? hourOverride : getAirportLocalHour(airport);
    const dow = getAirportLocalDow(airport);
    const tIdx = terminalIdx !== undefined ? terminalIdx : selectedTerminal;
    const terminalName = airport.terminals[tIdx] || airport.terminals[0];

    const base = sizeBase(airport.size);
    const timeMult = timeMultiplier(hour);
    const dayMult = dowMultiplier(dow);

    // Seed changes every 2 minutes for more dynamic feel
    const seed = hashCode(airport.code + terminalName + hour + Math.floor(Date.now() / 120000));
    const rand = seededRandom(seed);

    // Terminal variation: different terminals get different multipliers
    const terminalSeed = hashCode(terminalName + airport.code + Math.floor(Date.now() / 120000));
    const terminalVar = 0.7 + seededRandom(terminalSeed) * 0.6; // 0.7 to 1.3

    // Spike simulation: ~15% chance of a spike at any terminal during peak hours
    const spikeSeed = hashCode(airport.code + terminalName + Math.floor(Date.now() / 300000));
    const spikeRand = seededRandom(spikeSeed);
    const isPeakHour = (hour >= 6 && hour <= 9) || (hour >= 16 && hour <= 19);
    const hasSpike = isPeakHour && spikeRand > 0.85;
    const spikeMult = hasSpike ? (1.5 + spikeRand * 0.5) : 1.0;

    const jitter = 0.8 + rand * 0.4;

    const standardSecurity = Math.max(3, Math.round(base * timeMult * dayMult * jitter * terminalVar * spikeMult));
    const precheckSecurity = Math.max(1, Math.round(standardSecurity * (0.3 + rand * 0.15)));
    const checkin = Math.max(2, Math.round(base * 0.6 * timeMult * dayMult * (0.85 + rand * 0.3) * terminalVar));

    return { standardSecurity, precheckSecurity, checkin, hasSpike, terminalName };
}

// Generate wait times across all terminals to find spikes
function getAllTerminalWaits(airport, hourOverride) {
    return airport.terminals.map((t, i) => ({
        terminal: t,
        index: i,
        ...generateWaitTimes(airport, hourOverride, i)
    }));
}

function getWaitStatus(standardMin) {
    if (standardMin <= 10) return { label: "Low Wait", cls: "low" };
    if (standardMin <= 25) return { label: "Moderate", cls: "moderate" };
    return { label: "High Wait", cls: "high" };
}

function getBarWidth(minutes, max) {
    return Math.min(100, (minutes / max) * 100) + "%";
}

function getBarColor(minutes) {
    if (minutes <= 10) return "var(--green)";
    if (minutes <= 25) return "var(--yellow)";
    return "var(--red)";
}

function getTrendIcon(current, previous) {
    if (!previous) return "";
    const diff = current - previous;
    if (diff > 3) return '<span class="trend-up">↑ +' + diff + 'm</span>';
    if (diff < -3) return '<span class="trend-down">↓ ' + diff + 'm</span>';
    return '<span class="trend-flat">→ stable</span>';
}

// --- Tracker Init ---
function initTracker() {
    renderPopularAirports();
    setupSearch();
    populateAirlineDropdown();
    startLiveUpdates();
}

function populateAirlineDropdown() {
    const select = document.getElementById("airlineSelect");
    if (!select || typeof AIRLINES === "undefined") return;
    AIRLINES.forEach(a => {
        const opt = document.createElement("option");
        opt.value = a.code;
        opt.textContent = a.name;
        select.appendChild(opt);
    });
}

function renderPopularAirports() {
    const grid = document.getElementById("popularGrid");
    grid.innerHTML = "";
    POPULAR_AIRPORTS.forEach(code => {
        const airport = AIRPORTS.find(a => a.code === code);
        if (!airport) return;
        const wt = generateWaitTimes(airport, undefined, 0);
        const card = document.createElement("div");
        card.className = "popular-card";
        card.onclick = () => selectAirport(airport);
        card.innerHTML = `
            <span class="popular-code">${airport.code}</span>
            <span class="popular-name">${airport.city.split(",")[0]}</span>
            <span class="popular-wait" style="color: ${getBarColor(wt.standardSecurity)}">${wt.standardSecurity}m</span>
            ${wt.hasSpike ? '<span class="spike-dot">!</span>' : ''}
        `;
        grid.appendChild(card);
    });
}

// --- Search ---
function setupSearch() {
    const input = document.getElementById("airportSearch");
    const results = document.getElementById("searchResults");
    input.addEventListener("input", () => {
        const q = input.value.trim().toLowerCase();
        if (q.length < 1) {
            results.style.display = "none";
            // Restore hero if search cleared
            if (selectedAirport) {
                selectedAirport = null;
                document.getElementById("hero").classList.remove("hero-collapsed");
                document.getElementById("airportDashboard").style.display = "none";
                window.scrollTo({ top: 0, behavior: "smooth" });
            }
            return;
        }
        const matches = AIRPORTS.filter(a =>
            a.code.toLowerCase().includes(q) ||
            a.name.toLowerCase().includes(q) ||
            a.city.toLowerCase().includes(q)
        ).slice(0, 8);
        if (matches.length === 0) { results.style.display = "none"; return; }
        results.innerHTML = matches.map(a => `
            <div class="search-result-item" onclick="selectAirport(AIRPORTS.find(x => x.code === '${a.code}'))">
                <span class="result-code">${a.code}</span>
                <span class="result-name">${a.name}</span>
                <span class="result-city">${a.city}</span>
            </div>
        `).join("");
        results.style.display = "block";
    });
    input.addEventListener("focus", () => {
        input.select();
    });
    document.addEventListener("click", (e) => {
        if (!e.target.closest(".search-box")) results.style.display = "none";
    });
}

// --- Airport Selection ---
function selectAirport(airport) {
    selectedAirport = airport;
    selectedTerminal = 0;
    previousWaitTimes = {};
    document.getElementById("searchResults").style.display = "none";
    document.getElementById("airportSearch").value = airport.code + " — " + airport.name;
    document.getElementById("airportDashboard").style.display = "block";

    // Collapse hero into compact search bar
    const hero = document.getElementById("hero");
    hero.classList.add("hero-collapsed");

    // Scroll to dashboard
    document.getElementById("tracker").scrollIntoView({ behavior: "smooth", block: "start" });

    document.getElementById("airportName").textContent = airport.name;
    document.getElementById("airportCode").textContent = airport.code;
    document.getElementById("airportCity").textContent = airport.city;

    // Set date defaults
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const dateInput = document.getElementById("flightDate");
    if (dateInput) {
        dateInput.value = tomorrow.toISOString().split("T")[0];
        dateInput.min = new Date().toISOString().split("T")[0];
        const maxDate = new Date();
        maxDate.setDate(maxDate.getDate() + 1);
        dateInput.max = maxDate.toISOString().split("T")[0];
    }
    const timeInput = document.getElementById("flightTime");
    if (timeInput) timeInput.value = "10:00";

    // Reset prediction
    const predResult = document.getElementById("predictionResult");
    if (predResult) predResult.style.display = "none";

    renderTerminalTabs();
    updateDashboard();
    renderForecast();
    checkForSpikes();
}

// --- Terminal Tabs ---
function renderTerminalTabs() {
    const tabs = document.getElementById("terminalTabs");
    if (!selectedAirport || selectedAirport.terminals.length <= 1) {
        tabs.innerHTML = "";
        tabs.style.display = "none";
        return;
    }
    tabs.style.display = "flex";
    const allWaits = getAllTerminalWaits(selectedAirport);
    tabs.innerHTML = allWaits.map((tw, i) => {
        const active = i === selectedTerminal ? "active" : "";
        const spike = tw.hasSpike ? "spike" : "";
        return `<button class="terminal-tab ${active} ${spike}" onclick="switchTerminal(${i})">
            ${tw.terminal}
            <span class="tab-wait" style="color: ${getBarColor(tw.standardSecurity)}">${tw.standardSecurity}m</span>
            ${tw.hasSpike ? '<span class="tab-spike">SPIKE</span>' : ''}
        </button>`;
    }).join("");
}

function switchTerminal(idx) {
    selectedTerminal = idx;
    renderTerminalTabs();
    updateDashboard();
    checkForSpikes();
}

// --- Dashboard ---
function updateDashboard() {
    if (!selectedAirport) return;

    const wt = generateWaitTimes(selectedAirport);
    const status = getWaitStatus(wt.standardSecurity);
    const prevKey = selectedAirport.code + "-" + selectedTerminal;
    const prev = previousWaitTimes[prevKey];

    document.getElementById("secStandard").textContent = wt.standardSecurity;
    document.getElementById("secPrecheck").textContent = wt.precheckSecurity;
    document.getElementById("checkinTime").textContent = wt.checkin;

    // Trends
    document.getElementById("secStandardTrend").innerHTML = getTrendIcon(wt.standardSecurity, prev?.standardSecurity);
    document.getElementById("secPrecheckTrend").innerHTML = getTrendIcon(wt.precheckSecurity, prev?.precheckSecurity);
    document.getElementById("checkinTrend").innerHTML = getTrendIcon(wt.checkin, prev?.checkin);

    // Store for next comparison
    previousWaitTimes[prevKey] = { ...wt };

    const maxWait = 60;
    const stdBar = document.getElementById("secStandardBar");
    stdBar.style.width = getBarWidth(wt.standardSecurity, maxWait);
    stdBar.style.background = getBarColor(wt.standardSecurity);

    document.getElementById("secPrecheckBar").style.width = getBarWidth(wt.precheckSecurity, maxWait);
    document.getElementById("checkinBar").style.width = getBarWidth(wt.checkin, maxWait);

    const statusEl = document.getElementById("overallStatus");
    statusEl.textContent = status.label;
    statusEl.className = "status-badge " + status.cls;

    document.getElementById("statusDetail").textContent =
        wt.hasSpike ? "SPIKE DETECTED — expect significant delays" :
        status.cls === "low" ? "Lines are moving smoothly" :
        status.cls === "moderate" ? "Expect some delays at checkpoints" :
        "Significant delays — arrive early";

    updateDataSourceIndicator();
}

// --- Spike Detection & Urgency Alerts ---
function checkForSpikes() {
    if (!selectedAirport) {
        document.getElementById("urgencyBanner").style.display = "none";
        return;
    }

    const allWaits = getAllTerminalWaits(selectedAirport);
    const spikes = allWaits.filter(w => w.hasSpike);

    if (spikes.length === 0) {
        document.getElementById("urgencyBanner").style.display = "none";
        return;
    }

    // Find the worst spike
    const worst = spikes.reduce((a, b) => a.standardSecurity > b.standardSecurity ? a : b);

    document.getElementById("urgencyBanner").style.display = "flex";
    document.getElementById("urgencyText").innerHTML =
        `<strong>Security spike at ${worst.terminal}!</strong> Wait time jumped to <strong>${worst.standardSecurity} min</strong>. ` +
        (allWaits.length > 1
            ? `Fastest checkpoint: <strong>${allWaits.reduce((a,b) => a.standardSecurity < b.standardSecurity ? a : b).terminal}</strong> (${allWaits.reduce((a,b) => a.standardSecurity < b.standardSecurity ? a : b).standardSecurity} min).`
            : "Plan for extra time.");
}

// --- Forecast (Free) ---
function renderForecast() {
    if (!selectedAirport) return;
    const chart = document.getElementById("forecastChart");
    chart.innerHTML = "";
    const currentHour = getAirportLocalHour(selectedAirport);
    const maxWait = 50;
    for (let i = 0; i < 24; i++) {
        const hour = (currentHour + i) % 24;
        const wt = generateWaitTimes(selectedAirport, hour);
        const height = Math.max(8, (wt.standardSecurity / maxWait) * 170);
        const color = getBarColor(wt.standardSecurity);
        const wrap = document.createElement("div");
        wrap.className = "forecast-bar-wrap";
        wrap.innerHTML = `
            <div class="forecast-bar-value">${wt.standardSecurity}m</div>
            <div class="forecast-bar" style="height: ${height}px; background: ${color};"></div>
            <span class="forecast-bar-label">${hour.toString().padStart(2, "0")}:00</span>
        `;
        chart.appendChild(wrap);
    }
}

// --- Safe Zone / Risk Zone Prediction ---
function calculateArrival() {
    if (!selectedAirport) return;

    const dateStr = document.getElementById("flightDate").value;
    const timeStr = document.getElementById("flightTime").value;
    const ticketType = document.getElementById("ticketType").value;
    const airlineCode = document.getElementById("airlineSelect").value;

    if (!dateStr || !timeStr) {
        alert("Please enter both flight date and departure time.");
        return;
    }

    const flightDateTime = new Date(`${dateStr}T${timeStr}`);
    const now = new Date();
    const hoursUntil = (flightDateTime - now) / (1000 * 60 * 60);

    if (hoursUntil < 0) {
        alert("Flight time is in the past. Please enter a future time.");
        return;
    }
    if (hoursUntil > 25) {
        alert("You can only check predictions up to 24 hours before your flight.");
        return;
    }

    const flightHour = flightDateTime.getHours();
    const wt = generateWaitTimes(selectedAirport, flightHour);
    const securityWait = ticketType === "precheck" ? wt.precheckSecurity : wt.standardSecurity;

    // Apply airline-specific check-in multiplier
    let airlineMult = 1.0;
    let airlineName = "Average";
    if (airlineCode && typeof AIRLINES !== "undefined") {
        const airline = AIRLINES.find(a => a.code === airlineCode);
        if (airline) {
            airlineMult = airline.checkinMult;
            airlineName = airline.name;
        }
    }
    const checkinWait = Math.max(2, Math.round(wt.checkin * airlineMult));

    // Component times
    const parkingAndWalk = selectedAirport.size === "mega" ? 20 :
                           selectedAirport.size === "large" ? 15 : 10;
    const boardingBuffer = 30;

    // --- SAFE ZONE: generous buffer, 95% confidence ---
    const safeBuffer = selectedAirport.size === "mega" ? 35 :
                       selectedAirport.size === "large" ? 25 : 20;
    const safeTotalMin = securityWait + checkinWait + parkingAndWalk + boardingBuffer + safeBuffer;
    const safeArrivalTime = new Date(flightDateTime.getTime() - safeTotalMin * 60 * 1000);

    // --- RISK ZONE: minimal buffer, ~60% confidence ---
    const riskBuffer = 5;
    const riskSecurityWait = Math.round(securityWait * 0.8); // optimistic
    const riskCheckin = Math.round(checkinWait * 0.7);
    const riskTotalMin = riskSecurityWait + riskCheckin + parkingAndWalk + boardingBuffer + riskBuffer;
    const riskArrivalTime = new Date(flightDateTime.getTime() - riskTotalMin * 60 * 1000);

    // Drive time estimate (placeholder: user's commute)
    const driveTime = 30; // default 30 min commute

    const safeLeaveTime = new Date(safeArrivalTime.getTime() - driveTime * 60 * 1000);
    const riskLeaveTime = new Date(riskArrivalTime.getTime() - driveTime * 60 * 1000);

    const fmt = (d) => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });

    // Confidence adjustments
    const safeConf = Math.min(98, 93 + (hoursUntil < 3 ? 4 : hoursUntil < 6 ? 2 : 0) - (selectedAirport.size === "mega" ? 2 : 0));
    const riskConf = Math.min(70, 55 + (hoursUntil < 2 ? 10 : hoursUntil < 4 ? 5 : 0));

    // Safe Zone
    document.getElementById("safeArrival").textContent = fmt(safeArrivalTime);
    document.getElementById("safeLeave").textContent = fmt(safeLeaveTime);
    document.getElementById("safeConfidence").textContent = safeConf + "% confidence";
    document.getElementById("safeDetail").textContent =
        `${safeTotalMin} min before departure. Includes ${safeBuffer} min safety buffer. You'll likely have time at the gate.`;

    // Risk Zone
    document.getElementById("riskArrival").textContent = fmt(riskArrivalTime);
    document.getElementById("riskLeave").textContent = fmt(riskLeaveTime);
    document.getElementById("riskConfidence").textContent = riskConf + "% confidence";
    document.getElementById("riskDetail").textContent =
        `${riskTotalMin} min before departure. Minimal buffer. You may need to run. Not recommended.`;

    // Breakdown
    document.getElementById("breakdownGrid").innerHTML = `
        <div class="breakdown-row"><span>Security (${ticketType === "precheck" ? "PreCheck" : "Standard"})</span><span class="breakdown-safe">~${securityWait} min</span><span class="breakdown-risk">~${riskSecurityWait} min</span></div>
        <div class="breakdown-row"><span>Check-in (${airlineName})</span><span class="breakdown-safe">~${checkinWait} min</span><span class="breakdown-risk">~${riskCheckin} min</span></div>
        <div class="breakdown-row"><span>Parking & Walk</span><span class="breakdown-safe">${parkingAndWalk} min</span><span class="breakdown-risk">${parkingAndWalk} min</span></div>
        <div class="breakdown-row"><span>Boarding Buffer</span><span class="breakdown-safe">${boardingBuffer} min</span><span class="breakdown-risk">${boardingBuffer} min</span></div>
        <div class="breakdown-row"><span>Safety Buffer</span><span class="breakdown-safe">${safeBuffer} min</span><span class="breakdown-risk">${riskBuffer} min</span></div>
        <div class="breakdown-row total"><span>Total</span><span class="breakdown-safe">${safeTotalMin} min</span><span class="breakdown-risk">${riskTotalMin} min</span></div>
        <div class="breakdown-header"><span></span><span class="breakdown-safe">Safe</span><span class="breakdown-risk">Risk</span></div>
    `;

    document.getElementById("predictionResult").style.display = "block";

    // Dynamic urgency check
    checkDynamicUrgency(flightDateTime, safeTotalMin, riskTotalMin, driveTime);

    // Start continuous refresh
    startPredictionRefresh();
}

// --- Dynamic "Leave Now" Alert ---
function checkDynamicUrgency(flightDateTime, safeTotalMin, riskTotalMin, driveTime) {
    const now = new Date();
    const safeDeadline = new Date(flightDateTime.getTime() - (safeTotalMin + driveTime) * 60 * 1000);
    const riskDeadline = new Date(flightDateTime.getTime() - (riskTotalMin + driveTime) * 60 * 1000);

    const minToSafe = Math.round((safeDeadline - now) / 60000);
    const minToRisk = Math.round((riskDeadline - now) / 60000);

    const banner = document.getElementById("urgencyBanner");

    if (minToRisk <= 0) {
        banner.style.display = "flex";
        banner.className = "urgency-banner critical";
        document.getElementById("urgencyText").innerHTML =
            `<strong>You've passed the Risk Zone deadline.</strong> It is extremely unlikely you'll make this flight from the airport. Consider rebooking.`;
        document.getElementById("urgencyTimer").textContent = "";
    } else if (minToSafe <= 0) {
        banner.style.display = "flex";
        banner.className = "urgency-banner warning";
        document.getElementById("urgencyText").innerHTML =
            `<strong>Safe Zone has passed!</strong> You're now in the Risk Zone. You have <strong>${minToRisk} minutes</strong> before even the risky option expires. Leave immediately if going.`;
        document.getElementById("urgencyTimer").textContent = minToRisk + " min left";
    } else if (minToSafe <= 30) {
        banner.style.display = "flex";
        banner.className = "urgency-banner urgent";
        document.getElementById("urgencyText").innerHTML =
            `<strong>Leave soon!</strong> You have <strong>${minToSafe} minutes</strong> before the Safe Zone window closes. After that, you're in the Risk Zone.`;
        document.getElementById("urgencyTimer").textContent = minToSafe + " min";
    }
}

// --- Continuous Prediction Refresh ---
function startPredictionRefresh() {
    if (predictionInterval) clearInterval(predictionInterval);
    if (countdownInterval) clearInterval(countdownInterval);

    refreshCountdown = 120;
    updateCountdownDisplay();

    countdownInterval = setInterval(() => {
        refreshCountdown--;
        if (refreshCountdown <= 0) refreshCountdown = 120;
        updateCountdownDisplay();
    }, 1000);

    predictionInterval = setInterval(() => {
        if (selectedAirport) {
            calculateArrival();
        }
    }, 120000); // 2 minutes
}

function updateCountdownDisplay() {
    const el = document.getElementById("nextRefresh");
    if (el) {
        const min = Math.floor(refreshCountdown / 60);
        const sec = refreshCountdown % 60;
        el.textContent = `${min}:${sec.toString().padStart(2, "0")}`;
    }
}

// --- Live Updates ---
function startLiveUpdates() {
    if (liveUpdateInterval) clearInterval(liveUpdateInterval);
    liveUpdateInterval = setInterval(() => {
        if (selectedAirport) {
            // Re-fetch TSA data on each live update cycle
            if (activeDataSource === "tsa") {
                loadTSAData(selectedAirport);
            }
            updateDashboard();
            renderTerminalTabs();
            renderForecast();
            checkForSpikes();
        }
        renderPopularAirports();
    }, 120000); // 2 minutes
}

// --- Init ---
document.addEventListener("DOMContentLoaded", () => {
    initTracker();

    // Smooth scroll
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener("click", function (e) {
            const target = document.querySelector(this.getAttribute("href"));
            if (target) {
                e.preventDefault();
                target.scrollIntoView({ behavior: "smooth", block: "start" });
            }
        });
    });
});

// Close modals on overlay click
document.addEventListener("click", (e) => {
    if (e.target.classList.contains("modal-overlay")) {
        e.target.style.display = "none";
    }
});

// ============================================
// CROWDSOURCE & REAL DATA SYSTEM
// ============================================

// --- Data Source Toggle ---
let activeDataSource = "tsa"; // "tsa", "modeled", or "crowd"
let tsaWaitData = {}; // { airportCode: { data, timestamp } }

function setDataSource(source) {
    activeDataSource = source;
    document.getElementById("btnTSA").classList.toggle("active", source === "tsa");
    document.getElementById("btnModeled").classList.toggle("active", source === "modeled");
    document.getElementById("btnCrowd").classList.toggle("active", source === "crowd");
    updateDashboard();
    renderForecast();
    updateDataSourceIndicator();
}

// --- Crowdsource Storage (localStorage) ---
const CROWD_STORAGE_KEY = "airq_crowd_reports";

function getCrowdReports() {
    try {
        return JSON.parse(localStorage.getItem(CROWD_STORAGE_KEY) || "[]");
    } catch { return []; }
}

function saveCrowdReports(reports) {
    // Keep only last 500 reports and last 7 days
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const trimmed = reports.filter(r => r.timestamp > cutoff).slice(-500);
    localStorage.setItem(CROWD_STORAGE_KEY, JSON.stringify(trimmed));
}

function submitCrowdReport() {
    if (!selectedAirport) return;

    const waitMin = parseInt(document.getElementById("crowdWaitMin").value);
    const type = document.getElementById("crowdType").value;
    const terminalSelect = document.getElementById("crowdTerminal");
    const terminal = terminalSelect ? terminalSelect.value : selectedAirport.terminals[0];

    if (isNaN(waitMin) || waitMin < 0 || waitMin > 120) {
        alert("Please enter a valid wait time (0-120 minutes).");
        return;
    }

    const report = {
        airportCode: selectedAirport.code,
        terminal: terminal,
        type: type,
        waitMinutes: waitMin,
        timestamp: Date.now(),
        hour: getAirportLocalHour(selectedAirport),
        dow: getAirportLocalDow(selectedAirport)
    };

    const reports = getCrowdReports();
    reports.push(report);
    saveCrowdReports(reports);

    // Show thanks
    const thanks = document.getElementById("crowdThanks");
    thanks.style.display = "block";
    setTimeout(() => { thanks.style.display = "none"; }, 3000);

    // Clear input
    document.getElementById("crowdWaitMin").value = "";

    // Update stats
    updateCrowdStats();

    // Refresh dashboard if in crowd mode
    if (activeDataSource === "crowd") {
        updateDashboard();
    }
}

function updateCrowdStats() {
    if (!selectedAirport) return;

    const reports = getCrowdReports();
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const airportReports = reports.filter(r =>
        r.airportCode === selectedAirport.code && r.timestamp >= todayStart.getTime()
    );

    document.getElementById("crowdCount").textContent = airportReports.length;

    if (airportReports.length > 0) {
        const avg = Math.round(airportReports.reduce((s, r) => s + r.waitMinutes, 0) / airportReports.length);
        document.getElementById("crowdAvg").textContent = avg + " min";
        const lastReport = airportReports[airportReports.length - 1];
        const lastTime = new Date(lastReport.timestamp).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
        document.getElementById("crowdLast").textContent = lastTime;
    } else {
        document.getElementById("crowdAvg").textContent = "--";
        document.getElementById("crowdLast").textContent = "--";
    }
}

function getCrowdWaitTimes(airport, terminalIdx) {
    const reports = getCrowdReports();
    const tIdx = terminalIdx !== undefined ? terminalIdx : selectedTerminal;
    const terminalName = airport.terminals[tIdx] || airport.terminals[0];

    // Get reports for this airport/terminal from last 2 hours
    const cutoff = Date.now() - 2 * 60 * 60 * 1000;
    const relevant = reports.filter(r =>
        r.airportCode === airport.code &&
        r.terminal === terminalName &&
        r.timestamp > cutoff
    );

    if (relevant.length === 0) {
        // Fall back to modeled data
        return null;
    }

    // Weight recent reports more heavily
    let weightedSum = 0;
    let weightTotal = 0;
    relevant.forEach(r => {
        const age = (Date.now() - r.timestamp) / 60000; // minutes old
        const weight = Math.max(0.1, 1 - (age / 120)); // decay over 2 hours
        weightedSum += r.waitMinutes * weight;
        weightTotal += weight;
    });

    const standardSecurity = Math.round(weightedSum / weightTotal);
    const precheckReports = relevant.filter(r => r.type === "precheck");
    let precheckSecurity;
    if (precheckReports.length > 0) {
        precheckSecurity = Math.round(precheckReports.reduce((s, r) => s + r.waitMinutes, 0) / precheckReports.length);
    } else {
        precheckSecurity = Math.max(1, Math.round(standardSecurity * 0.35));
    }

    return {
        standardSecurity,
        precheckSecurity,
        checkin: Math.max(2, Math.round(standardSecurity * 0.5)),
        hasSpike: standardSecurity > 30,
        terminalName,
        source: "crowd",
        reportCount: relevant.length
    };
}

// Populate terminal dropdown for crowdsource
function updateCrowdTerminalDropdown() {
    if (!selectedAirport) return;
    const select = document.getElementById("crowdTerminal");
    if (!select) return;
    select.innerHTML = selectedAirport.terminals.map(t =>
        `<option value="${t}">${t}</option>`
    ).join("");

    // Hide terminal group if only one terminal
    const group = document.getElementById("crowdTerminalGroup");
    if (group) {
        group.style.display = selectedAirport.terminals.length > 1 ? "flex" : "none";
    }
}

// --- Override generateWaitTimes to check TSA/crowd data ---
const _originalGenerateWaitTimes = generateWaitTimes;
generateWaitTimes = function(airport, hourOverride, terminalIdx) {
    // Only use real data for current-time queries (no hour override)
    if (hourOverride === undefined) {
        if (activeDataSource === "tsa") {
            const tsaData = getTSAWaitTimes(airport, terminalIdx);
            if (tsaData) return tsaData;
            // Fall through to modeled if TSA data unavailable
        }
        if (activeDataSource === "crowd") {
            const crowdData = getCrowdWaitTimes(airport, terminalIdx);
            if (crowdData) return crowdData;
        }
    }
    return _originalGenerateWaitTimes(airport, hourOverride, terminalIdx);
};

// ============================================
// TSA REAL DATA — via Cloudflare Worker proxy
// Fetches real wait times from the official TSA MyTSA Web Service
// ============================================

// IMPORTANT: After deploying the Cloudflare Worker, replace this URL
// Deploy: cd worker && npx wrangler deploy
const TSA_PROXY_URL = "https://tsa-proxy.YOUR_SUBDOMAIN.workers.dev";

const TSA_CACHE_KEY = "airq_tsa_cache";
const TSA_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function fetchTSAWaitTimes(airportCode) {
    // Check localStorage cache first
    try {
        const cache = JSON.parse(localStorage.getItem(TSA_CACHE_KEY) || "{}");
        const cached = cache[airportCode];
        if (cached && Date.now() - cached.timestamp < TSA_CACHE_TTL) {
            return cached;
        }
    } catch {}

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);

        const response = await fetch(
            `${TSA_PROXY_URL}?airport=${airportCode}`,
            { signal: controller.signal }
        );
        clearTimeout(timeout);

        if (!response.ok) return null;
        const result = await response.json();

        if (!result || !result.data) return null;

        // Parse TSA data into our internal format
        const parsed = parseTSAData(result.data, airportCode);
        if (!parsed) return null;

        const cacheEntry = {
            waitTimes: parsed,
            timestamp: Date.now(),
            tsaTimestamp: result.timestamp,
            source: result.source
        };

        // Save to localStorage cache
        try {
            const cache = JSON.parse(localStorage.getItem(TSA_CACHE_KEY) || "{}");
            cache[airportCode] = cacheEntry;
            localStorage.setItem(TSA_CACHE_KEY, JSON.stringify(cache));
        } catch {}

        return cacheEntry;
    } catch {
        return null;
    }
}

// Parse TSA API response into our wait time format
// TSA data can come in different formats depending on the endpoint
function parseTSAData(data, airportCode) {
    // Handle array of wait time records
    const records = Array.isArray(data) ? data : (data.WaitTimes || data.waitTimes || [data]);
    if (!records || records.length === 0) return null;

    const terminals = {};

    for (const record of records) {
        // TSA fields vary: WaitTime, wait_time, estimated_wait, mins, etc.
        const waitMin = parseInt(
            record.WaitTime || record.wait_time || record.estimated_wait ||
            record.mins || record.waittime || record.minutes || 0
        );
        // Checkpoint / terminal name
        const checkpoint = record.CheckpointName || record.checkpoint ||
            record.CheckPoint || record.terminal || record.name || "Main";
        // PreCheck indicator
        const isPrecheck = (record.PreCheck === "true" || record.precheck === true ||
            (checkpoint && checkpoint.toLowerCase().includes("precheck")));

        if (!terminals[checkpoint]) {
            terminals[checkpoint] = { standard: [], precheck: [] };
        }

        if (isPrecheck) {
            terminals[checkpoint].precheck.push(waitMin);
        } else {
            terminals[checkpoint].standard.push(waitMin);
        }
    }

    // Aggregate per terminal
    const result = {};
    for (const [name, data] of Object.entries(terminals)) {
        const stdWaits = data.standard.length > 0 ? data.standard : [0];
        const pcWaits = data.precheck.length > 0 ? data.precheck : null;

        const avgStd = Math.round(stdWaits.reduce((a, b) => a + b, 0) / stdWaits.length);
        const avgPc = pcWaits
            ? Math.round(pcWaits.reduce((a, b) => a + b, 0) / pcWaits.length)
            : Math.max(1, Math.round(avgStd * 0.35));

        result[name] = {
            standardSecurity: Math.max(1, avgStd),
            precheckSecurity: Math.max(1, avgPc),
            checkin: Math.max(2, Math.round(avgStd * 0.5)),
            hasSpike: avgStd > 30,
            terminalName: name,
            source: "tsa",
            reportCount: stdWaits.length + (pcWaits ? pcWaits.length : 0)
        };
    }

    return Object.keys(result).length > 0 ? result : null;
}

// Get TSA-based wait times for a specific terminal
function getTSAWaitTimes(airport, terminalIdx) {
    const code = airport.code;
    const cached = tsaWaitData[code];
    if (!cached || !cached.waitTimes) return null;

    const tIdx = terminalIdx !== undefined ? terminalIdx : selectedTerminal;
    const terminalName = airport.terminals[tIdx] || airport.terminals[0];

    // Try exact terminal match first
    if (cached.waitTimes[terminalName]) {
        return cached.waitTimes[terminalName];
    }

    // Try partial match (TSA checkpoint names don't always match exactly)
    for (const [name, wt] of Object.entries(cached.waitTimes)) {
        if (name.toLowerCase().includes(terminalName.toLowerCase()) ||
            terminalName.toLowerCase().includes(name.toLowerCase())) {
            return wt;
        }
    }

    // If only one checkpoint reported, use it for all terminals
    const keys = Object.keys(cached.waitTimes);
    if (keys.length === 1) {
        return cached.waitTimes[keys[0]];
    }

    // Use average across all checkpoints
    const all = Object.values(cached.waitTimes);
    return {
        standardSecurity: Math.round(all.reduce((s, w) => s + w.standardSecurity, 0) / all.length),
        precheckSecurity: Math.round(all.reduce((s, w) => s + w.precheckSecurity, 0) / all.length),
        checkin: Math.round(all.reduce((s, w) => s + w.checkin, 0) / all.length),
        hasSpike: all.some(w => w.hasSpike),
        terminalName: terminalName,
        source: "tsa",
        reportCount: all.reduce((s, w) => s + w.reportCount, 0)
    };
}

// Load TSA data for an airport and refresh dashboard
async function loadTSAData(airport) {
    const result = await fetchTSAWaitTimes(airport.code);
    if (result && result.waitTimes) {
        tsaWaitData[airport.code] = result;
        updateDataSourceIndicator();
        if (activeDataSource === "tsa") {
            updateDashboard();
            renderTerminalTabs();
            checkForSpikes();
        }
    } else {
        // TSA data unavailable — indicate fallback
        tsaWaitData[airport.code] = null;
        updateDataSourceIndicator();
    }
}

// Update the data source indicator in the header
function updateDataSourceIndicator() {
    const indicator = document.getElementById("lastUpdated");
    if (!indicator || !selectedAirport) return;

    const time = new Date().toLocaleTimeString();

    if (activeDataSource === "tsa") {
        const cached = tsaWaitData[selectedAirport.code];
        if (cached && cached.waitTimes) {
            const age = Math.round((Date.now() - cached.timestamp) / 60000);
            const ageText = age < 1 ? "just now" : age + "m ago";
            indicator.innerHTML = `${time} <span style="color: var(--green); font-size: 0.65rem; font-weight: 600;">TSA LIVE (${ageText})</span>`;
        } else {
            indicator.innerHTML = `${time} <span style="color: var(--yellow); font-size: 0.65rem; font-weight: 600;">TSA unavailable — showing modeled</span>`;
        }
    } else if (activeDataSource === "crowd") {
        indicator.innerHTML = `${time} <span style="color: var(--blue, #4da6ff); font-size: 0.65rem;">CROWDSOURCED</span>`;
    } else {
        indicator.innerHTML = `${time} <span style="color: var(--text-muted); font-size: 0.65rem;">MODELED</span>`;
    }
}

// Patch selectAirport to load TSA data and update crowd UI
const _patchedSelectAirport = selectAirport;
selectAirport = function(airport) {
    _patchedSelectAirport(airport);
    updateCrowdTerminalDropdown();
    updateCrowdStats();
    loadTSAData(airport);
    updateDataSourceIndicator();
};
