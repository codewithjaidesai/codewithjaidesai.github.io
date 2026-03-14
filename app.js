// ============================================
// AirQ - Airport Security Tracker App
// ============================================

// --- State ---
let selectedAirport = null;
let predictionInterval = null;
let liveUpdateInterval = null;

// --- Access Control ---
const ACCESS_KEY_PREFIX = "AIRQ";
const STORAGE_KEY = "airq_access_key";

function isUnlocked() {
    return !!localStorage.getItem(STORAGE_KEY);
}

function unlockApp(key) {
    localStorage.setItem(STORAGE_KEY, key);
    document.getElementById("paywall").style.display = "none";
    document.getElementById("trackerApp").style.display = "block";
    initTracker();
}

function generateAccessKey() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const seg = () => Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
    return `${ACCESS_KEY_PREFIX}-${seg()}-${seg()}-${seg()}`;
}

function handlePurchase() {
    // Simulate Stripe payment flow
    // In production, this would redirect to Stripe Checkout
    const key = generateAccessKey();

    // Show success modal with key
    document.getElementById("accessKeyDisplay").textContent = key;
    document.getElementById("successModal").style.display = "flex";

    unlockApp(key);
}

function showAccessKeyModal() {
    document.getElementById("accessKeyModal").style.display = "flex";
}

function closeAccessKeyModal() {
    document.getElementById("accessKeyModal").style.display = "none";
    document.getElementById("accessKeyError").style.display = "none";
}

function verifyAccessKey() {
    const input = document.getElementById("accessKeyInput").value.trim().toUpperCase();
    if (input.startsWith(ACCESS_KEY_PREFIX + "-") && input.length >= 16) {
        unlockApp(input);
        closeAccessKeyModal();
    } else {
        document.getElementById("accessKeyError").style.display = "block";
    }
}

function closeSuccessModal() {
    document.getElementById("successModal").style.display = "none";
}

// --- Wait Time Generation (Realistic Simulation) ---
// Uses time-of-day patterns, day-of-week, airport size, and randomness

function getAirportLocalHour(airport) {
    try {
        const now = new Date();
        const formatter = new Intl.DateTimeFormat("en-US", {
            hour: "numeric",
            hour12: false,
            timeZone: airport.timezone
        });
        return parseInt(formatter.format(now));
    } catch {
        return new Date().getHours();
    }
}

function getAirportLocalDow(airport) {
    try {
        const now = new Date();
        const formatter = new Intl.DateTimeFormat("en-US", {
            weekday: "short",
            timeZone: airport.timezone
        });
        return formatter.format(now);
    } catch {
        return ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][new Date().getDay()];
    }
}

// Time-of-day multiplier (peaks at 6-9am and 4-7pm)
function timeMultiplier(hour) {
    const curve = [
        0.3, 0.2, 0.15, 0.15, 0.25, 0.5,   // 0-5
        0.85, 1.0, 0.95, 0.8, 0.7, 0.65,     // 6-11
        0.6, 0.55, 0.5, 0.55, 0.75, 0.9,     // 12-17
        0.7, 0.5, 0.4, 0.35, 0.3, 0.25       // 18-23
    ];
    return curve[hour] || 0.5;
}

// Day-of-week multiplier
function dowMultiplier(dow) {
    const mults = { Sun: 1.1, Mon: 0.95, Tue: 0.75, Wed: 0.8, Thu: 0.9, Fri: 1.15, Sat: 0.85 };
    return mults[dow] || 1.0;
}

// Airport size base times (minutes)
function sizeBase(size) {
    const bases = { mega: 28, large: 20, medium: 14, small: 8 };
    return bases[size] || 12;
}

function generateWaitTimes(airport, hourOverride) {
    const hour = hourOverride !== undefined ? hourOverride : getAirportLocalHour(airport);
    const dow = getAirportLocalDow(airport);

    const base = sizeBase(airport.size);
    const timeMult = timeMultiplier(hour);
    const dayMult = dowMultiplier(dow);

    // Add some controlled randomness (seeded by airport code + hour for consistency within short periods)
    const seed = hashCode(airport.code + hour + Math.floor(Date.now() / 300000)); // changes every 5 min
    const rand = seededRandom(seed);

    const jitter = 0.8 + rand * 0.4; // 0.8 to 1.2

    const standardSecurity = Math.max(3, Math.round(base * timeMult * dayMult * jitter));
    const precheckSecurity = Math.max(1, Math.round(standardSecurity * (0.3 + rand * 0.15)));
    const checkin = Math.max(2, Math.round(base * 0.6 * timeMult * dayMult * (0.85 + rand * 0.3)));

    return { standardSecurity, precheckSecurity, checkin };
}

function hashCode(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash |= 0;
    }
    return Math.abs(hash);
}

function seededRandom(seed) {
    const x = Math.sin(seed) * 10000;
    return x - Math.floor(x);
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

// --- Tracker Init ---
function initTracker() {
    renderPopularAirports();
    setupSearch();
    startLiveUpdates();
}

function renderPopularAirports() {
    const grid = document.getElementById("popularGrid");
    grid.innerHTML = "";

    POPULAR_AIRPORTS.forEach(code => {
        const airport = AIRPORTS.find(a => a.code === code);
        if (!airport) return;

        const wt = generateWaitTimes(airport);
        const status = getWaitStatus(wt.standardSecurity);

        const card = document.createElement("div");
        card.className = "popular-card";
        card.onclick = () => selectAirport(airport);
        card.innerHTML = `
            <span class="popular-code">${airport.code}</span>
            <span class="popular-name">${airport.city.split(",")[0]}</span>
            <span class="popular-wait" style="color: ${getBarColor(wt.standardSecurity)}">${wt.standardSecurity}m</span>
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
            return;
        }

        const matches = AIRPORTS.filter(a =>
            a.code.toLowerCase().includes(q) ||
            a.name.toLowerCase().includes(q) ||
            a.city.toLowerCase().includes(q)
        ).slice(0, 8);

        if (matches.length === 0) {
            results.style.display = "none";
            return;
        }

        results.innerHTML = matches.map(a => `
            <div class="search-result-item" onclick="selectAirport(AIRPORTS.find(x => x.code === '${a.code}'))">
                <span class="result-code">${a.code}</span>
                <span class="result-name">${a.name}</span>
                <span class="result-city">${a.city}</span>
            </div>
        `).join("");
        results.style.display = "block";
    });

    // Close results on click outside
    document.addEventListener("click", (e) => {
        if (!e.target.closest(".search-box")) {
            results.style.display = "none";
        }
    });
}

// --- Airport Selection ---
function selectAirport(airport) {
    selectedAirport = airport;
    document.getElementById("searchResults").style.display = "none";
    document.getElementById("airportSearch").value = "";
    document.getElementById("airportDashboard").style.display = "block";
    document.getElementById("popularAirports").style.display = "none";

    // Set airport info
    document.getElementById("airportName").textContent = airport.name;
    document.getElementById("airportCode").textContent = airport.code;
    document.getElementById("airportCity").textContent = airport.city;

    // Set default flight date/time
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    document.getElementById("flightDate").value = tomorrow.toISOString().split("T")[0];
    document.getElementById("flightDate").min = new Date().toISOString().split("T")[0];
    const maxDate = new Date();
    maxDate.setDate(maxDate.getDate() + 1);
    document.getElementById("flightDate").max = maxDate.toISOString().split("T")[0];
    document.getElementById("flightTime").value = "10:00";

    // Reset prediction
    document.getElementById("predictionResult").style.display = "none";

    updateDashboard();
    renderForecast();
}

function updateDashboard() {
    if (!selectedAirport) return;

    const wt = generateWaitTimes(selectedAirport);
    const status = getWaitStatus(wt.standardSecurity);

    // Update wait times
    document.getElementById("secStandard").textContent = wt.standardSecurity;
    document.getElementById("secPrecheck").textContent = wt.precheckSecurity;
    document.getElementById("checkinTime").textContent = wt.checkin;

    // Update bars
    const maxWait = 60;
    const stdBar = document.getElementById("secStandardBar");
    stdBar.style.width = getBarWidth(wt.standardSecurity, maxWait);
    stdBar.style.background = getBarColor(wt.standardSecurity);

    const preBar = document.getElementById("secPrecheckBar");
    preBar.style.width = getBarWidth(wt.precheckSecurity, maxWait);

    const chkBar = document.getElementById("checkinBar");
    chkBar.style.width = getBarWidth(wt.checkin, maxWait);

    // Status
    const statusEl = document.getElementById("overallStatus");
    statusEl.textContent = status.label;
    statusEl.className = "status-badge " + status.cls;

    document.getElementById("statusDetail").textContent =
        status.cls === "low" ? "Lines are moving smoothly" :
        status.cls === "moderate" ? "Expect some delays at checkpoints" :
        "Significant delays — arrive early";

    // Update timestamp
    document.getElementById("lastUpdated").textContent = new Date().toLocaleTimeString();
}

// --- Forecast ---
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

// --- Arrival Prediction ---
function calculateArrival() {
    if (!selectedAirport) return;

    const dateStr = document.getElementById("flightDate").value;
    const timeStr = document.getElementById("flightTime").value;
    const ticketType = document.getElementById("ticketType").value;

    if (!dateStr || !timeStr) {
        alert("Please enter both flight date and departure time.");
        return;
    }

    const flightDateTime = new Date(`${dateStr}T${timeStr}`);
    const now = new Date();

    // Check if within 24 hours
    const hoursUntil = (flightDateTime - now) / (1000 * 60 * 60);
    if (hoursUntil < 0) {
        alert("Flight time is in the past. Please enter a future time.");
        return;
    }
    if (hoursUntil > 25) {
        alert("You can only check predictions up to 24 hours before your flight.");
        return;
    }

    // Calculate predicted wait at flight time
    const flightHour = flightDateTime.getHours();
    const wt = generateWaitTimes(selectedAirport, flightHour);

    const securityWait = ticketType === "precheck" ? wt.precheckSecurity : wt.standardSecurity;
    const checkinWait = wt.checkin;

    // Time components (in minutes)
    const parkingAndWalk = selectedAirport.size === "mega" ? 20 :
                           selectedAirport.size === "large" ? 15 : 10;
    const boardingBuffer = 30; // Must be at gate 30 min before
    const personalBuffer = 15; // Safety buffer

    const totalMinutes = securityWait + checkinWait + parkingAndWalk + boardingBuffer + personalBuffer;

    // Calculate arrival time
    const arrivalTime = new Date(flightDateTime.getTime() - totalMinutes * 60 * 1000);

    // Display
    const timeFormat = arrivalTime.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });

    document.getElementById("arrivalTime").textContent = timeFormat;
    document.getElementById("predictionBreakdown").innerHTML = `
        Security: ~${securityWait} min (${ticketType === "precheck" ? "PreCheck" : "Standard"})<br>
        Check-in: ~${checkinWait} min<br>
        Parking & Walk: ~${parkingAndWalk} min<br>
        Boarding Buffer: ${boardingBuffer} min<br>
        Safety Buffer: ${personalBuffer} min<br>
        <strong>Total: ${totalMinutes} min before departure</strong>
    `;

    // Confidence (higher when closer to flight, lower for mega airports)
    const baseConf = ticketType === "precheck" ? 92 : 88;
    const sizeAdj = selectedAirport.size === "mega" ? -6 :
                    selectedAirport.size === "large" ? -3 : 0;
    const timeAdj = hoursUntil < 3 ? 5 : hoursUntil < 6 ? 2 : 0;
    const confidence = Math.min(98, Math.max(70, baseConf + sizeAdj + timeAdj));

    document.getElementById("confidenceFill").style.width = confidence + "%";
    document.getElementById("confidencePercent").textContent = confidence + "%";

    document.getElementById("predictionResult").style.display = "block";

    // Set up continuous prediction refresh
    if (predictionInterval) clearInterval(predictionInterval);
    predictionInterval = setInterval(() => {
        if (selectedAirport) calculateArrival();
    }, 5 * 60 * 1000); // Refresh every 5 minutes
}

// --- Live Updates ---
function startLiveUpdates() {
    if (liveUpdateInterval) clearInterval(liveUpdateInterval);

    liveUpdateInterval = setInterval(() => {
        if (selectedAirport) {
            updateDashboard();
            renderForecast();
        }
        renderPopularAirports();
    }, 5 * 60 * 1000); // Every 5 minutes
}

// --- Init on Load ---
document.addEventListener("DOMContentLoaded", () => {
    if (isUnlocked()) {
        document.getElementById("paywall").style.display = "none";
        document.getElementById("trackerApp").style.display = "block";
        initTracker();
    }

    // Smooth scroll for anchor links
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
