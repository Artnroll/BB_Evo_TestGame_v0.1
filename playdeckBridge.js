// playdeckBridge.js
(function () {
    'use strict';

    // --- Configuration ----
    const DEFAULT_AD_BLOCK_ID = '15960';
    const ADSGRAM_INIT_OPTS = { blockId: DEFAULT_AD_BLOCK_ID, debug: false, debugConsole: true };
    const UNITY_SEND_RETRY_MS = 250;
    const UNITY_SEND_MAX_RETRIES = 30;

    // Small safe console wrappers
    function safeLog(...args) { try { console.log(...args); } catch (e) { } }
    function safeWarn(...args) { try { console.warn(...args); } catch (e) { } }
    function safeError(...args) { try { console.error(...args); } catch (e) { } }

    // Local helper to reliably send messages to Unity
    function sendToUnity(objectName, methodName, message) {
        let tries = 0;
        const trySend = () => {
            tries++;
            try {
                const instance = (window.playDeckBridge && window.playDeckBridge.unityInstance) ? window.playDeckBridge.unityInstance : window.unityInstance;
                if (instance && typeof instance.SendMessage === 'function') {
                    instance.SendMessage(objectName, methodName, message);
                    safeLog(`sendToUnity: Sent -> ${objectName}.${methodName}("${message}")`);
                    return true;
                }
            } catch (e) {
                safeWarn('sendToUnity: send exception', e);
            }
            if (tries * UNITY_SEND_RETRY_MS >= UNITY_SEND_MAX_RETRIES * UNITY_SEND_RETRY_MS) {
                safeWarn(`sendToUnity: giving up after ${tries} tries for ${objectName}.${methodName}`);
                return false;
            }
            setTimeout(trySend, UNITY_SEND_RETRY_MS);
        };
        trySend();
    }

    // Bridge object
    const bridge = {
        unityInstance: null,
        init(unity) {
            this.unityInstance = unity;
            safeLog('PlayDeckBridge: unityInstance set');
        }
    };

    // Expose bridge
    window.playDeckBridge = bridge;

    // --- IMMEDIATE SAFE STUBS ---
    window.PlayDeck_SetLoading = function (progress) { safeLog('PlayDeck_SetLoading (stub):', progress); };
    window.PlayDeck_GameEnd = function () {
        safeLog('PlayDeck_GameEnd (stub)');
        try { window.parent.postMessage({ playdeck: { method: 'gameEnd' } }, '*'); } catch (e) { }
    };
    window.PlayDeck_Analytics = function (eventName, payload) { safeLog('PlayDeck_Analytics (stub):', eventName, payload); };
    window.PlayDeck_AreAdsAvailable = function () { safeLog('PlayDeck_AreAdsAvailable (stub) -> 0'); return 0; };
    window.PlayDeck_PreloadAds = function () { safeLog('PlayDeck_PreloadAds (stub)'); };
    window.PlayDeck_ShowRewardedAdForBlock = function (blockId) {
        safeLog('PlayDeck_ShowRewardedAdForBlock (stub) called with blockId:', blockId);
        try { sendToUnity('AdsManager', 'OnAdCompleted', "false"); } catch (e) { }
    };
    window.PlayDeck_ShowTaskForBlock = function (blockId) {
        safeLog('PlayDeck_ShowTaskForBlock (stub) called with', blockId);
        try { sendToUnity('AdsManager', 'OnTaskCompleted', "false"); } catch (e) { }
        return 0;
    };
    window.PlayDeck_ShowRewardedAd = function () {
        safeLog('PlayDeck_ShowRewardedAd (stub) called - delegating to block function');
        try { window.PlayDeck_ShowRewardedAdForBlock(DEFAULT_AD_BLOCK_ID); } catch (e) { safeWarn(e); }
    };

    // ===== TELEGRAM STARS INTEGRATION =====

    const starsIntegration = {
        BACKEND_URL: 'https://telegram-server-payment.onrender.com',

        // check if telegram stars are available
        isAvailable() {
            return !!(window.Telegram && window.Telegram.WebApp);
        },

        // Get telegram user ID
        getUserId() {
            const user = window.Telegram?.WebApp?.initDataUnsafe?.user;
            return user ? user.id : null;
        },

        // main purchase function
        async purchaseItem(itemId, starsCost, itemName, itemDescription) {
            safeLog('Telegram Stars: purchaseItem called for', itemId, 'cost:', starsCost);

            if (!this.isAvailable()) {
                const error = 'Telegram WebApp not available';
                safeWarn('Telegram Stars:', error);
                return { success: false, error: error };
            }

            const userId = this.getUserId();
            if (!userId) {
                return { success: false, error: 'User not identified'}
            }

            try {
                safeLog('Creating invoice via backend');

                // call backend to create telegram invoice
                const result = await this.createInvoiceViaBackend(userId, itemId, starsCost, itemName, itemDescription);
                return result;
            } catch (error) {
                safeError('Telegram Stars: Purchase error', error)
                return {success: false, error: error.message};
            }
        },

        // create invoice by calling our backend
        async createInvoiceViaBackend(userId, itemId, starsCost, itemName, itemDescription) {
            try {
                safeLog('Calling backend to create invoice...');

                const response = await fetch(`${this.BACKEND_URL}/create-invoice`, {                    method: 'POST',
                    headers:{
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        user_id: userId,
                        item_id: itemId,
                        amount: starsCost,
                        title: itemName,
                        description: itemDescription
                    })
                });

                if (!response.ok) {
                    throw new Error(`Backend error: ${response.status}`);
                }

                const result = await response.json();
                safeLog('Backend response:', result);

                if (result.success) {
                    // invoice was sent to user by telegram
                    // now we wait for payment
                    return {
                        success: true,
                        message: 'Invoice sent! Check your Telegram chat with the bot.',
                        item_id: itemId,
                        invoice_id: result.invoice_id
                    };
                } else {
                    return {
                        success: false,
                        error: result.error || 'Failed to create invoice'
                    };
                }
            } catch (error) {
                safeError('Backend call failed:', error);
                return {
                    success: false,
                    error: 'Could not connect to payment server' + error.message
                };
            }
        } 
    }

    // ===== SINGLE FUNCTION EXPOSURE =====

    window.PlayDeck_BuyItemWithStars = function (itemId, starsCost, itemName, itemDescription) {
        safeLog('PlayDeck_BuyItemWithStars called with:', itemId, starsCost, itemName);

        // Handle the purchase and send result to Unity
        starsIntegration.purchaseItem(itemId, starsCost, itemName, itemDescription)
            .then(result => {
                // Send result back to Unity
                const resultJson = JSON.stringify(result);
                safeLog('Sending purchase result to Unity:', resultJson);
                sendToUnity('TelegramStarsManager', 'OnPurchaseResult', resultJson);
            })
            .catch(error => {
                // Send error to Unity
                const errorResult = JSON.stringify({
                    success: false,
                    error: error.message,
                    item: itemId
                });
                safeError('Purchase failed:', error);
                sendToUnity('TelegramStarsManager', 'OnPurchaseResult', errorResult);
            });
    };

    // ===== ADSGRAM INTEGRATION (KEEPING ORIGINAL) =====
    let adsState = {
        methodType: null,
        controller: null,
        methodName: null,
        ready: false,
        globalName: null
    };

    function detectAdsGram() {
        const G = window;
        const candidateNames = ['AdsGram', 'Adsgram', 'AdsGramSDK', 'AdsgramSDK', 'sad', 'Ads', 'adsgram'];
        for (const name of candidateNames) {
            if (G[name]) {
                safeLog('playdeckBridge: detected AdsGram global as', name);
                adsState.globalName = name;
                return G[name];
            }
        }
        if (G.sad && (G.sad.AdsGram || G.sad.Adsgram)) {
            safeLog('playdeckBridge: detected AdsGram under sad namespace');
            adsState.globalName = 'sad.AdsGram';
            return G.sad.AdsGram || G.sad.Adsgram;
        }
        return null;
    }

    function initializeAdsGramIfPossible() {
        const globalAds = detectAdsGram();
        if (!globalAds) return false;

        // ... rest of AdsGram initialization (unchanged)
    }

    // Replace ad stubs with real implementations when AdsGram is ready
    function exposeRealAdFunctions() {
        window.PlayDeck_AreAdsAvailable = function () {
            try {
                const available = (adsState && adsState.ready) ? 1 : 0;
                safeLog('PlayDeck_AreAdsAvailable ->', available);
                return Number(available);
            } catch (e) {
                safeWarn('PlayDeck_AreAdsAvailable error', e);
                return 0;
            }
        };

        window.PlayDeck_PreloadAds = function () {
            safeLog('PlayDeck_PreloadAds called');
            if (!adsState.ready) initializeAdsGramIfPossible();
        };

        // ... rest of ad function implementations (unchanged)
    }

    // AdsGram initialization attempts
    let initAttempts = 0;
    const maxInitAttempts = 10;
    const initTimer = setInterval(() => {
        initAttempts++;
        if (!adsState.ready) initializeAdsGramIfPossible();
        if (adsState.ready || initAttempts >= maxInitAttempts) {
            clearInterval(initTimer);
            exposeRealAdFunctions();
            if (!adsState.ready) {
                safeWarn('playdeckBridge: AdsGram not detected after attempts; using fallback functions.');
            }
        }
    }, 700);

    // ===== EXISTING TELEGRAM USER FUNCTION =====
    window.getTelegramUserFull = function (unityObjectName, callbackMethod) {
        // [Keep your existing Telegram user function unchanged]
    };

    // ===== FINAL BRIDGE SETUP =====
    window.playDeckBridge = Object.assign(window.playDeckBridge || {}, {
        init: function (unityInstance) { bridge.init(unityInstance); },
        stars: starsIntegration,
        _internalState: () => ({
            adsState: adsState,
            starsAvailable: starsIntegration.isAvailable(),
            telegramAvailable: !!(window.Telegram && window.Telegram.WebApp)
        })
    });

    safeLog('playdeckBridge loaded with SIMPLIFIED Telegram Stars (No Backend)');

})();


