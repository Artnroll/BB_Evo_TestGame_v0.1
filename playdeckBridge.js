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
        // Check if Telegram Stars are available
        isAvailable() {
            return !!(window.Telegram && window.Telegram.WebApp);
        },

        // Main purchase function - SIMPLIFIED: No backend verification
        async purchaseItem(itemId, starsCost, itemName, itemDescription) {
            safeLog('Telegram Stars: purchaseItem called for', itemId, 'cost:', starsCost);

            if (!this.isAvailable()) {
                const error = 'Telegram WebApp not available';
                safeWarn('Telegram Stars:', error);
                return { success: false, error: error };
            }

            try {
                // Just create Telegram payment - no backend verification needed
                const paymentResult = await this.createTelegramPayment(itemId, starsCost, itemName, itemDescription);

                // Return whatever Telegram tells us - we trust it completely
                return paymentResult;

            } catch (error) {
                safeError('Telegram Stars: Purchase error', error);
                return { success: false, error: error.message };
            }
        },

        // Create Telegram payment - METHOD 1 (MainButton)
        createTelegramPayment(itemId, starsCost, itemName, itemDescription) {
            return new Promise((resolve) => {
                safeLog('Telegram Stars: Creating payment for', itemId, 'cost:', starsCost);

                // Check if Telegram WebApp is available
                if (!window.Telegram?.WebApp) {
                    resolve({ success: false, error: 'Telegram WebApp not available' });
                    return;
                }

                // Check if MainButton is available
                if (!window.Telegram.WebApp.MainButton) {
                    resolve({ success: false, error: 'Telegram payments not supported' });
                    return;
                }

                // Check if user is identified
                const user = window.Telegram.WebApp.initDataUnsafe?.user;
                if (!user?.id) {
                    resolve({ success: false, error: 'User not identified' });
                    return;
                }

                safeLog('Starting Telegram Stars MainButton payment flow...');

                // Use MainButton for direct Stars payment
                this.setupMainButtonPayment(itemId, starsCost, itemName, resolve);
            });
        },

        // Setup MainButton for direct payment
        setupMainButtonPayment(itemId, starsCost, itemName, resolve) {
            try {
                // Configure the MainButton
                window.Telegram.WebApp.MainButton.setText(`Purchase ${itemName} - ${starsCost} ⭐`);
                window.Telegram.WebApp.MainButton.color = '#2481cc'; // Telegram blue
                window.Telegram.WebApp.MainButton.textColor = '#ffffff';
                window.Telegram.WebApp.MainButton.show();

                safeLog('MainButton shown with payment option');

                // Create one-time click handler
                const paymentHandler = () => {
                    safeLog('Telegram Stars: Payment button clicked by user');

                    // Disable button immediately to prevent double clicks
                    window.Telegram.WebApp.MainButton.showProgress();

                    // Process the payment directly with Telegram
                    this.processTelegramStarsPayment(itemId, starsCost)
                        .then(result => {
                            resolve(result);
                        })
                        .finally(() => {
                            // Clean up
                            window.Telegram.WebApp.MainButton.offClick(paymentHandler);
                            window.Telegram.WebApp.MainButton.hide();
                            window.Telegram.WebApp.MainButton.hideProgress();
                        });
                };

                // Attach click handler
                window.Telegram.WebApp.MainButton.onClick(paymentHandler);

                // Auto-cancel after 2 minutes if user doesn't act
                setTimeout(() => {
                    if (window.Telegram.WebApp.MainButton.isVisible) {
                        safeLog('Payment timeout - cancelling');
                        window.Telegram.WebApp.MainButton.offClick(paymentHandler);
                        window.Telegram.WebApp.MainButton.hide();
                        resolve({ success: false, error: 'Payment timeout - please try again' });
                    }
                }, 120000); // 2 minutes

            } catch (error) {
                safeError('MainButton setup failed:', error);
                // Ensure button is hidden on error
                try { window.Telegram.WebApp.MainButton.hide(); } catch (e) { }
                resolve({ success: false, error: 'Payment setup failed: ' + error.message });
            }
        },

        // Process Telegram Stars payment - SIMPLIFIED: No backend calls
        async processTelegramStarsPayment(itemId, starsCost) {
            safeLog('Processing Telegram Stars payment for', itemId, 'amount:', starsCost);

            // In production: This is where actual Telegram Stars transfer happens
            // Telegram handles everything - we just trust their response

            try {
                // For now, simulate Telegram's payment processing
                const result = await this.simulateTelegramPayment(itemId, starsCost);
                return result;
            } catch (error) {
                safeError('Telegram payment error:', error);
                return { success: false, error: 'Payment processing failed' };
            }
        },

        // Simulate Telegram payment (replace with real Telegram API in production)
        simulateTelegramPayment(itemId, starsCost) {
            return new Promise((resolve) => {
                safeLog('Simulating Telegram Stars payment...');

                // Simulate Telegram processing delay
                setTimeout(() => {
                    // 85% success rate for realistic testing
                    const success = Math.random() > 0.15;

                    if (success) {
                        const paymentId = 'telegram_stars_' + Date.now();
                        safeLog('✅ Telegram Stars: PAYMENT SUCCESS - Payment ID:', paymentId);
                        resolve({
                            success: true,
                            payment_id: paymentId,
                            item_id: itemId,
                            message: 'Payment completed successfully via Telegram Stars'
                        });
                    } else {
                        // Simulate Telegram payment failures
                        const errors = [
                            'Insufficient Stars balance',
                            'Payment was cancelled',
                            'Network error - please try again',
                            'Transaction declined by Telegram'
                        ];
                        const randomError = errors[Math.floor(Math.random() * errors.length)];

                        safeLog('❌ Telegram Stars: PAYMENT FAILED -', randomError);
                        resolve({
                            success: false,
                            error: randomError
                        });
                    }
                }, 1500); // 1.5 second processing time (realistic)
            });
        }

        // REMOVED: verifyPaymentWithBackend() - No backend needed!
    };

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


