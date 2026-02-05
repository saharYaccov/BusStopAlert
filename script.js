// Global variables
let map;
let userMarker;
let stationMarker;
let routeLine;
let alertCircle;
let userLocation = null;
let selectedStation = null;
let trackingInterval = null;
let isTracking = false;
let hasAlerted = false;
let alertSound = null;

const ALERT_DISTANCE = 5; // km
const TRACKING_INTERVAL = 5000; // 5 seconds

// Initialize map
function initMap() {
    // Center map on Israel by default
    map = L.map('map').setView([32.0853, 34.7818], 8);
    
    // Add OpenStreetMap tiles
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 19
    }).addTo(map);
}

// Initialize alert sound
function initAlertSound() {
    alertSound = new Audio();
    
    // Try multiple formats for better compatibility
    const formats = [
        { src: 'alert/a01.mp3', type: 'audio/mpeg' },
        { src: 'alert/a01.ogg', type: 'audio/ogg' },
        { src: 'alert/a01.wav', type: 'audio/wav' }
    ];
    
    // Find first supported format
    for (const format of formats) {
        if (alertSound.canPlayType(format.type)) {
            alertSound.src = format.src;
            console.log(`Alert sound initialized: ${format.src}`);
            break;
        }
    }
    
    // Preload the audio
    alertSound.load();
    
    // Test if audio file exists
    alertSound.addEventListener('error', (e) => {
        console.warn('Alert sound file not found or could not be loaded:', e);
        showStatus('⚠️ קובץ הצלצול לא נמצא - ישתמשו התראות ויזואליות בלבד', 'warning');
    });
}

// Get user's current location
function getUserLocation() {
    return new Promise((resolve, reject) => {
        if (!navigator.geolocation) {
            reject(new Error('הדפדפן לא תומך בשירות מיקום'));
            return;
        }

        navigator.geolocation.getCurrentPosition(
            (position) => {
                userLocation = {
                    lat: position.coords.latitude,
                    lng: position.coords.longitude,
                    accuracy: position.coords.accuracy
                };
                
                updateUserMarker();
                resolve(userLocation);
            },
            (error) => {
                let errorMessage = 'לא ניתן לאתר את המיקום';
                switch (error.code) {
                    case error.PERMISSION_DENIED:
                        errorMessage = 'נדרשת הרשאה לגישה למיקום';
                        break;
                    case error.POSITION_UNAVAILABLE:
                        errorMessage = 'מידע מיקום לא זמין';
                        break;
                    case error.TIMEOUT:
                        errorMessage = 'בקשת מיקום פגה';
                        break;
                }
                reject(new Error(errorMessage));
            },
            {
                enableHighAccuracy: true,
                timeout: 10000,
                maximumAge: 0
            }
        );
    });
}

// Update user marker on map
function updateUserMarker() {
    if (!userLocation) return;

    if (userMarker) {
        userMarker.setLatLng([userLocation.lat, userLocation.lng]);
    } else {
        userMarker = L.marker([userLocation.lat, userLocation.lng], {
            icon: L.divIcon({
                className: 'custom-marker',
                html: '<div style="background: #3B82F6; width: 24px; height: 24px; border-radius: 50%; border: 4px solid white; box-shadow: 0 2px 8px rgba(0,0,0,0.3);"></div>',
                iconSize: [32, 32],
                iconAnchor: [16, 16]
            }),
            title: 'המיקום שלך'
        }).addTo(map);

        // Center map on user if no station selected
        if (!selectedStation) {
            map.setView([userLocation.lat, userLocation.lng], 14);
        }
    }
}

// Enhanced search for bus stations using multiple strategies
async function searchBusStation(query) {
    try {
        showStatus('מחפש תחנות...', 'info');
        
        // Strategy 1: Direct search with "bus stop" or "bus station"
        const searches = [
            `${query} bus stop`,
            `${query} תחנה`,
            `${query} תחנת אוטובוס`,
            query  // Original query as fallback
        ];
        
        let allResults = [];
        
        for (const searchQuery of searches) {
            try {
                const response = await fetch(
                    `https://nominatim.openstreetmap.org/search?` +
                    `format=json&` +
                    `q=${encodeURIComponent(searchQuery)}&` +
                    `limit=15&` +
                    `countrycodes=il&` +
                    `addressdetails=1&` +
                    `bounded=0`
                );

                if (response.ok) {
                    const results = await response.json();
                    allResults = allResults.concat(results);
                }
                
                // Small delay to respect API rate limits
                await new Promise(resolve => setTimeout(resolve, 500));
            } catch (err) {
                console.warn(`Search failed for: ${searchQuery}`, err);
            }
        }
        
        // Remove duplicates based on coordinates (within 50 meters)
        const uniqueResults = [];
        allResults.forEach(result => {
            const isDuplicate = uniqueResults.some(existing => {
                const distance = calculateDistance(
                    parseFloat(result.lat),
                    parseFloat(result.lon),
                    parseFloat(existing.lat),
                    parseFloat(existing.lon)
                );
                return distance < 0.05; // 50 meters
            });
            
            if (!isDuplicate) {
                uniqueResults.push(result);
            }
        });
        
        // Filter and prioritize results
        const filteredResults = uniqueResults
            .filter(result => {
                const name = result.display_name.toLowerCase();
                const type = (result.type || '').toLowerCase();
                const category = (result.class || '').toLowerCase();
                
                // Prioritize bus stops, stations, and public transport
                return (
                    type.includes('bus_stop') ||
                    type.includes('station') ||
                    category.includes('highway') ||
                    category.includes('public_transport') ||
                    name.includes('תחנ') ||
                    name.includes('bus') ||
                    name.includes('station')
                );
            })
            .slice(0, 10); // Limit to top 10
        
        if (filteredResults.length === 0 && uniqueResults.length > 0) {
            // If no filtered results, show all unique results
            showStatus(`נמצאו ${Math.min(uniqueResults.length, 10)} תוצאות`, 'success');
            return uniqueResults.slice(0, 10);
        }
        
        if (filteredResults.length === 0) {
            showStatus('לא נמצאו תחנות. נסה שם אחר או הוסף "תחנה" לחיפוש', 'warning');
            return [];
        }

        showStatus(`נמצאו ${filteredResults.length} תחנות`, 'success');
        return filteredResults;

    } catch (error) {
        console.error('Search error:', error);
        showStatus('שגיאה בחיפוש תחנות', 'error');
        return [];
    }
}

// Display search suggestions
function displaySuggestions(results) {
    const suggestionsList = document.getElementById('suggestions-list');
    suggestionsList.innerHTML = '';

    if (results.length === 0) {
        suggestionsList.classList.remove('show');
        return;
    }

    results.forEach(result => {
        const item = document.createElement('div');
        item.className = 'suggestion-item';
        
        const name = document.createElement('div');
        name.className = 'suggestion-name';
        // Extract station name more intelligently
        const displayParts = result.display_name.split(',');
        const stationName = displayParts[0];
        name.textContent = stationName;
        
        const address = document.createElement('div');
        address.className = 'suggestion-address';
        // Show city and area for context
        address.textContent = displayParts.slice(1, 3).join(', ') || result.display_name;
        
        item.appendChild(name);
        item.appendChild(address);
        
        item.addEventListener('click', () => {
            selectStation(result);
            suggestionsList.classList.remove('show');
        });
        
        suggestionsList.appendChild(item);
    });

    suggestionsList.classList.add('show');
}

// Select a station
function selectStation(station) {
    selectedStation = {
        name: station.display_name.split(',')[0],
        address: station.display_name,
        lat: parseFloat(station.lat),
        lng: parseFloat(station.lon)
    };

    // Update UI
    document.getElementById('station-name').textContent = selectedStation.name;
    document.getElementById('station-address').textContent = selectedStation.address;
    document.getElementById('selected-station').style.display = 'block';
    document.getElementById('station-input').value = selectedStation.name;

    // Add station marker
    if (stationMarker) {
        stationMarker.setLatLng([selectedStation.lat, selectedStation.lng]);
    } else {
        stationMarker = L.marker([selectedStation.lat, selectedStation.lng], {
            icon: L.divIcon({
                className: 'custom-marker',
                html: '<div style="background: #FF6B35; width: 24px; height: 24px; border-radius: 50%; border: 4px solid white; box-shadow: 0 2px 8px rgba(0,0,0,0.3);"></div>',
                iconSize: [32, 32],
                iconAnchor: [16, 16]
            }),
            title: 'תחנת אוטובוס'
        }).addTo(map);
    }

    // Add alert circle (1.5km radius)
    if (alertCircle) {
        map.removeLayer(alertCircle);
    }
    alertCircle = L.circle([selectedStation.lat, selectedStation.lng], {
        radius: ALERT_DISTANCE * 1000,
        color: '#F59E0B',
        fillColor: '#FEF3C7',
        fillOpacity: 0.2,
        weight: 2,
        dashArray: '10, 10'
    }).addTo(map);

    // Fit map to show both points if user location exists
    if (userLocation) {
        const bounds = L.latLngBounds(
            [userLocation.lat, userLocation.lng],
            [selectedStation.lat, selectedStation.lng]
        );
        map.fitBounds(bounds, { padding: [50, 50] });
    } else {
        map.setView([selectedStation.lat, selectedStation.lng], 14);
    }

    showStatus('תחנה נבחרה בהצלחה!', 'success');
}

// Calculate distance using Haversine formula
function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // Earth's radius in kilometers
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    
    const a = 
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const distance = R * c;
    
    return distance;
}

// Convert degrees to radians
function toRad(degrees) {
    return degrees * (Math.PI / 180);
}

// Format distance for display
function formatDistance(km) {
    if (km < 1) {
        return `${Math.round(km * 1000)} מטר`;
    }
    return `${km.toFixed(2)} ק"מ`;
}

// Calculate walking time
function calculateWalkingTime(km) {
    const hours = km / 5;
    const minutes = Math.round(hours * 60);
    
    if (minutes < 1) {
        return 'פחות מדקה';
    } else if (minutes === 1) {
        return 'כדקה';
    } else if (minutes < 60) {
        return `כ-${minutes} דקות הליכה`;
    } else {
        const hrs = Math.floor(minutes / 60);
        const mins = minutes % 60;
        return `כ-${hrs} שעות ו-${mins} דקות הליכה`;
    }
}

// Show status message
function showStatus(message, type = 'info') {
    const statusEl = document.getElementById('status-message');
    statusEl.textContent = message;
    statusEl.className = `status-message ${type} show`;
    
    setTimeout(() => {
        statusEl.classList.remove('show');
    }, 3000);
}

// Draw route line
function drawRouteLine() {
    if (!userLocation || !selectedStation) return;

    if (routeLine) {
        map.removeLayer(routeLine);
    }

    routeLine = L.polyline(
        [[userLocation.lat, userLocation.lng], [selectedStation.lat, selectedStation.lng]],
        {
            color: '#FF6B35',
            weight: 4,
            opacity: 0.7,
            dashArray: '10, 10',
            lineJoin: 'round'
        }
    ).addTo(map);
}

// Update distance display
function updateDistanceDisplay(distance) {
    const resultsSection = document.getElementById('results-section');
    const distanceValue = document.getElementById('distance-value');
    const walkingTime = document.getElementById('walking-time');
    const userLocationEl = document.getElementById('user-location');
    const stationLocationEl = document.getElementById('station-location');
    const lastUpdateEl = document.getElementById('last-update');
    const resultCard = document.getElementById('result-card');
    const alertZone = document.getElementById('alert-zone');

    distanceValue.textContent = formatDistance(distance);
    walkingTime.textContent = calculateWalkingTime(distance);
    userLocationEl.textContent = `${userLocation.lat.toFixed(6)}, ${userLocation.lng.toFixed(6)}`;
    stationLocationEl.textContent = `${selectedStation.lat.toFixed(6)}, ${selectedStation.lng.toFixed(6)}`;
    lastUpdateEl.textContent = new Date().toLocaleTimeString('he-IL');

    resultsSection.style.display = 'block';

    // Check if in alert zone
    if (distance <= ALERT_DISTANCE) {
        resultCard.classList.add('alert-active');
        alertZone.style.display = 'block';
        
        // Play alert sound only once when entering zone
        if (!hasAlerted) {
            playAlertSound();
            hasAlerted = true;
            showStatus('⚠️ הגעת לאזור ההתראה! קרוב לתחנה!', 'warning');
            
            // Also trigger browser notification if permitted
            showBrowserNotification();
        }
    } else {
        resultCard.classList.remove('alert-active');
        alertZone.style.display = 'none';
        hasAlerted = false; // Reset for next time
    }

    drawRouteLine();
}

// Play alert sound
function playAlertSound() {
    if (!alertSound) {
        console.warn('Alert sound not initialized');
        return;
    }
    
    // Reset to start and play
    alertSound.currentTime = 0;
    
    // Try to play with error handling
    const playPromise = alertSound.play();
    
    if (playPromise !== undefined) {
        playPromise
            .then(() => {
                console.log('Alert sound playing');
            })
            .catch(error => {
                console.warn('Could not play alert sound:', error);
                // Show visual alert if sound fails
                showStatus('🔔 התראה: הגעת לתחנה!', 'warning');
            });
    }
}

// Show browser notification
function showBrowserNotification() {
    if ('Notification' in window && Notification.permission === 'granted') {
        new Notification('התראת קרבה לתחנה', {
            body: `אתה במרחק של פחות מ-${ALERT_DISTANCE} ק"מ מהתחנה!`,
            icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y="75" font-size="75">🔔</text></svg>',
            vibrate: [200, 100, 200]
        });
    }
}

// Request notification permission
function requestNotificationPermission() {
    if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission().then(permission => {
            if (permission === 'granted') {
                console.log('Notification permission granted');
            }
        });
    }
}


function armAlertSound() {
    if (!alertSound) return;

    alertSound.volume = 0;       // שקט
    alertSound.currentTime = 0;

    alertSound.play()
        .then(() => {
            alertSound.pause();
            alertSound.currentTime = 0;
            alertSound.volume = 1; // מחזיר ווליום
            console.log('🔓 Alert sound armed');
        })
        .catch(err => {
            console.warn('Audio arming failed:', err);
        });
}

// Start tracking
async function startTracking() {
    if (!selectedStation) {
        showStatus('בחר תחנה תחילה', 'error');
        return;
    }

        // 🔔 חימוש אודיו – חובה!
    armAlertSound();

    
    try {
        // Request notification permission
        requestNotificationPermission();
        
        // Get initial location
        await getUserLocation();
        
        isTracking = true;
        document.getElementById('start-tracking-btn').style.display = 'none';
        document.getElementById('stop-tracking-btn').style.display = 'block';
        document.getElementById('tracking-section').style.display = 'block';

        // Initial calculation
        const distance = calculateDistance(
            userLocation.lat,
            userLocation.lng,
            selectedStation.lat,
            selectedStation.lng
        );
        updateDistanceDisplay(distance);

        // Fit map to show both points
        const bounds = L.latLngBounds(
            [userLocation.lat, userLocation.lng],
            [selectedStation.lat, selectedStation.lng]
        );
        map.fitBounds(bounds, { padding: [50, 50] });

        // Start continuous tracking
        trackingInterval = setInterval(async () => {
            try {
                await getUserLocation();
                
                const distance = calculateDistance(
                    userLocation.lat,
                    userLocation.lng,
                    selectedStation.lat,
                    selectedStation.lng
                );
                
                updateDistanceDisplay(distance);
            } catch (error) {
                console.error('Tracking update error:', error);
            }
        }, TRACKING_INTERVAL);

        showStatus('מעקב החל בהצלחה!', 'success');

    } catch (error) {
        showStatus(error.message, 'error');
    }
}

// Stop tracking
function stopTracking() {
    if (trackingInterval) {
        clearInterval(trackingInterval);
        trackingInterval = null;
    }

    isTracking = false;
    hasAlerted = false;
    document.getElementById('start-tracking-btn').style.display = 'block';
    document.getElementById('stop-tracking-btn').style.display = 'none';
    document.getElementById('tracking-section').style.display = 'none';

    showStatus('מעקב הופסק', 'info');
}

// Event listeners
document.addEventListener('DOMContentLoaded', () => {
    // Initialize map
    initMap();
    
    // Initialize alert sound
    initAlertSound();

    // Try to get user location on load
    getUserLocation().catch(err => {
        console.log('Could not get initial location:', err.message);
    });

    // Search button
    const searchBtn = document.getElementById('search-btn');
    const stationInput = document.getElementById('station-input');

    searchBtn.addEventListener('click', async () => {
        const query = stationInput.value.trim();
        if (!query) {
            showStatus('הזן שם תחנה', 'error');
            return;
        }

        searchBtn.classList.add('loading');
        searchBtn.disabled = true;

        const results = await searchBusStation(query);
        displaySuggestions(results);

        searchBtn.classList.remove('loading');
        searchBtn.disabled = false;
    });

    // Enter key in search input
    stationInput.addEventListener('keypress', async (e) => {
        if (e.key === 'Enter') {
            searchBtn.click();
        }
    });

    // Hide suggestions when clicking outside
    document.addEventListener('click', (e) => {
        const suggestionsList = document.getElementById('suggestions-list');
        if (!e.target.closest('.input-group')) {
            suggestionsList.classList.remove('show');
        }
    });

    // Start tracking button
    const startTrackingBtn = document.getElementById('start-tracking-btn');
    startTrackingBtn.addEventListener('click', startTracking);

    // Stop tracking button
    const stopTrackingBtn = document.getElementById('stop-tracking-btn');
    stopTrackingBtn.addEventListener('click', stopTracking);
});

// Stop tracking when page is closed/hidden
document.addEventListener('visibilitychange', () => {
    if (document.hidden && isTracking) {
        // Keep tracking in background if possible
        console.log('Page hidden, tracking continues in background');
    }
});

// Handle page unload
window.addEventListener('beforeunload', () => {
    if (trackingInterval) {
        clearInterval(trackingInterval);
    }
});
