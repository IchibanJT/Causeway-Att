let socket;
let audioContext;
let audioWorkletNode;
let source;
let isRunning = false;
let audioQueue = [];
let isPlaying = false;
let nextStartTime = 0;
const JITTER_BUFFER_THRESHOLD = 3; // Wait for initial chunks to prevent stutter
let videoStream;
let videoInterval;

const startBtn = document.getElementById('start-btn');
const stopBtn = document.getElementById('stop-btn');
const apiKeyInput = document.getElementById('api-key');
const statusText = document.getElementById('status-text');
const statusDot = document.getElementById('status-dot');
const chatLog = document.getElementById('chat-log');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const cameraPreview = document.getElementById('camera-preview');
const cameraStatus = document.getElementById('camera-status');
const overlayCanvas = document.getElementById('overlay-canvas');
const overlayCtx = overlayCanvas.getContext('2d');

// Helper to convert ArrayBuffer to Base64 efficiently
function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}

// Pre-fill API key from Vite environment variables if available
if (import.meta.env.VITE_GEMINI_API_KEY) {
  apiKeyInput.value = import.meta.env.VITE_GEMINI_API_KEY;
}

// Initialize visualizer
function drawVisualizer() {
  requestAnimationFrame(drawVisualizer);
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (!isRunning) return;

  ctx.fillStyle = 'rgba(92, 124, 250, 0.4)';
  const barWidth = 4;
  const barGap = 2;
  const bars = Math.floor(canvas.width / (barWidth + barGap));

  for (let i = 0; i < bars; i++) {
    const h = Math.random() * (canvas.height / 2);
    ctx.fillRect(i * (barWidth + barGap), (canvas.height - h) / 2, barWidth, h);
  }
}

function updateStatus(text, dynamic = false) {
  statusText.textContent = text;
  if (dynamic) {
    statusDot.classList.add('active');
  } else {
    statusDot.classList.remove('active');
  }
}

function appendMessage(role, text) {
  const entry = document.createElement('div');
  entry.className = `chat-entry ${role}`;
  entry.innerHTML = `<div class="bubble">${text}</div>`;
  chatLog.appendChild(entry);
  chatLog.scrollTop = chatLog.scrollHeight;
}

async function startSession() {
  const apiKey = apiKeyInput.value.trim();
  if (!apiKey) {
    alert('Please enter your Gemini API Key');
    return;
  }

  try {
    updateStatus('Connecting...');

    // 0. Immediate UI Feedback & Media Activation
    isRunning = true;
    startBtn.disabled = true;
    stopBtn.disabled = false;
    startCamera();
    drawVisualizer(); // Ensure visualizer starts immediately

    // 1. Initialize WebSocket (v1alpha for 3.1 preview stability)
    const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${apiKey}`;
    socket = new WebSocket(url);

    socket.onopen = () => {
      console.log('WebSocket Opened');
      updateStatus('Connected', true);

      // Send Comprehensive Setup for 3.1 (using required camelCase keys)
      const setupMsg = {
        setup: {
          model: "models/gemini-3.1-flash-live-preview",
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: "Puck"
                }
              }
            }
          },
          systemInstruction: {
            parts: [{
              text: "You are a helpful, safety-conscious DIY assistant. You can see the user through their camera feed. Your job is to walk them through solving tasks by hand (like changing a car tire, fixing a faucet, etc.) step-by-step. Speak naturally, be encouraging, and give clear instructions based on exactly what you see in the video. If you see them doing something dangerous, warn them immediately. Keep your responses concise and focused on the current step."
            }]
          }
        }
      };
      socket.send(JSON.stringify(setupMsg));
      console.log('Setup Sent, waiting for setupComplete...');
    };

    socket.onmessage = async (event) => {
      const response = JSON.parse(event.data);
      console.log('Received Message', response);
      
      // 2. Handle Handshake Completion
      if (response.setupComplete) {
        console.log('Setup Complete! Starting media loops...');
        // startCamera() is already active
        startAudio();
        startVideoStreaming();
        appendMessage('gemini', 'Connected and ready! I can see and hear you.');
        return;
      }
      
      if (response.serverContent) {
        const turn = response.serverContent.modelTurn;
        if (turn && turn.parts) {
          for (const part of turn.parts) {
            if (part.inlineData) {
              const base64Data = part.inlineData.data;
              enqueueAudio(base64Data);
            }
            if (part.text) {
              appendMessage('gemini', part.text);
            }
          }
        }
      }
    };

    socket.onerror = (err) => {
      console.error('WebSocket Error', err);
      updateStatus('Connection Error');
      stopSession();
    };

    socket.onclose = (event) => {
      console.log('WebSocket Closed', event);
      if (isRunning) {
        if (event.code === 1011) {
          appendMessage('gemini', 'Server Error (1011): The model rejected the setup. This often happens if the API key is restricted or the model ID is incorrect for your region.');
        } else if (event.code !== 1000) {
          appendMessage('gemini', `Connection closed (Code: ${event.code}).`);
        }
        stopSession();
      }
    };

  } catch (error) {
    console.error('Session Start Failed', error);
    updateStatus('Failed to Start');
  }
}

async function startCamera() {
  try {
    // Flexible constraints for wider device support
    videoStream = await navigator.mediaDevices.getUserMedia({
      video: true 
    });
    cameraPreview.srcObject = videoStream;
    cameraStatus.textContent = 'Camera Live';
    cameraStatus.style.background = 'rgba(55, 178, 77, 0.6)';
    console.log('Camera started');
  } catch (error) {
    console.error('Camera Access Failed', error);
    appendMessage('gemini', 'Error: Could not access camera. Please check permissions.');
  }
}

function startVideoStreaming() {
  videoInterval = setInterval(() => {
    if (socket && socket.readyState === WebSocket.OPEN && isRunning) {
      sendVideoFrame();
    }
  }, 1000); // 1 frame per second
}

function sendVideoFrame() {
  const tempCanvas = document.createElement('canvas');
  const tempCtx = tempCanvas.getContext('2d');

  // Targeted resolution for Gemini Live vision
  tempCanvas.width = 768;
  tempCanvas.height = 768;

  // Draw and crop/center
  const sWidth = cameraPreview.videoWidth;
  const sHeight = cameraPreview.videoHeight;
  const minDim = Math.min(sWidth, sHeight);
  const sx = (sWidth - minDim) / 2;
  const sy = (sHeight - minDim) / 2;

  tempCtx.drawImage(cameraPreview, sx, sy, minDim, minDim, 0, 0, 768, 768);

  const base64 = tempCanvas.toDataURL('image/jpeg', 0.6).split(',')[1];

  const msg = {
    realtimeInput: {
      mediaChunks: [
        {
          mimeType: "image/jpeg",
          data: base64
        }
      ]
    }
  };
  socket.send(JSON.stringify(msg));
}

async function startAudio() {
  try {
      // Switch to 24000Hz (Native AI Voice rate) for crystal clear, static-free output
      audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
      await audioContext.resume();
      console.log('AudioContext resumed at native 24kHz');

      await audioContext.audioWorklet.addModule('audio-worklet-processor.js');

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

    // Check if session was stopped while waiting for mic permission
    if (!audioContext || !isRunning) {
      stream.getTracks().forEach(track => track.stop());
      return;
    }

    source = audioContext.createMediaStreamSource(stream);

    audioWorkletNode = new AudioWorkletNode(audioContext, 'pcm-processor');

    let audioBuffer = new Int16Array(1600); // 100ms buffer at 16kHz
    let bufferOffset = 0;

    audioWorkletNode.port.onmessage = (event) => {
      if (socket && socket.readyState === WebSocket.OPEN && isRunning) {
        const inputData = new Int16Array(event.data);
        
        // Group chunks to reduce WebSocket overhead (wait for ~100ms)
        for (let i = 0; i < inputData.length; i++) {
          audioBuffer[bufferOffset++] = inputData[i];
          
          if (bufferOffset >= audioBuffer.length) {
            const base64 = arrayBufferToBase64(audioBuffer.buffer);
        // 16kHz for Gemini input is still standard for the API, even if our context is 24kHz
        const msg = {
          realtimeInput: {
            mediaChunks: [
              {
                mimeType: "audio/pcm;rate=16000",
                data: base64
              }
            ]
          }
        };
            socket.send(JSON.stringify(msg));
            bufferOffset = 0;
          }
        }
      }
    };

    source.connect(audioWorkletNode);
    // audioWorkletNode.connect(audioContext.destination); <--- REMOVED to stop feedback (static)

    appendMessage('gemini', 'Listening... Talk to me!');

  } catch (error) {
    console.error('Audio Setup Failed', error);
    appendMessage('gemini', 'Error: Could not access microphone.');
  }
}

function enqueueAudio(base64) {
  try {
    const binaryString = atob(base64);
    const len = binaryString.length;
    // Ensure we have an even number of bytes for Int16
    const safeLen = len - (len % 2);
    const bytes = new Int16Array(safeLen / 2);
    
    for (let i = 0; i < safeLen; i += 2) {
      // Assemble Little Endian 16-bit PCM
      bytes[i / 2] = (binaryString.charCodeAt(i + 1) << 8) | binaryString.charCodeAt(i);
    }

    audioQueue.push(bytes);
    if (!isPlaying) {
      playNextChunk();
    }
  } catch (e) {
    console.error('Error decoding audio chunk', e);
  }
}

async function playNextChunk() {
  // Use a jitter buffer for the very first chunks to ensure stability
  if (audioQueue.length === 0 || (nextStartTime === 0 && audioQueue.length < JITTER_BUFFER_THRESHOLD)) {
    isPlaying = false;
    if (audioQueue.length === 0) nextStartTime = 0;
    return;
  }

  isPlaying = true;
  const chunk = audioQueue.shift();

  // Convert Int16 PCM to Float32 for Web Audio
  const float32 = new Float32Array(chunk.length);
  for (let i = 0; i < chunk.length; i++) {
    float32[i] = chunk[i] / 0x7FFF;
  }

  const buffer = audioContext.createBuffer(1, float32.length, 24000);
  buffer.getChannelData(0).set(float32);

  const bufferSource = audioContext.createBufferSource();
  bufferSource.buffer = buffer;
  bufferSource.connect(audioContext.destination);

  // High-precision scheduling to eliminate gaps (static/crackling)
  const currentTime = audioContext.currentTime;
  if (nextStartTime < currentTime) {
    // If we're behind, schedule slightly in the future
    nextStartTime = currentTime + 0.05;
  }

  bufferSource.start(nextStartTime);
  nextStartTime += buffer.duration;

  bufferSource.onended = () => {
    playNextChunk();
  };
}

function stopSession() {
  console.log('Stopping session and resetting UI...');
  
  // 1. Immediate UI Reset
  isRunning = false;
  startBtn.disabled = false;
  stopBtn.disabled = true;
  updateStatus('Disconnected');
  cameraStatus.textContent = 'Camera Off';
  cameraStatus.style.background = 'rgba(0, 0, 0, 0.6)';
  cameraPreview.srcObject = null;

  // 2. Resource Cleanup
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.close();
  }
  
  try {
    if (source) {
      if (source.mediaStream) {
        source.mediaStream.getTracks().forEach(track => track.stop());
      }
    }
    if (videoStream) {
      videoStream.getTracks().forEach(track => track.stop());
    }
    if (audioContext) {
      audioContext.close();
    }
  } catch (e) {
    console.error('Cleanup error', e);
  }

  if (videoInterval) clearInterval(videoInterval);

  // 3. Reset State Variables
  socket = null;
  audioContext = null;
  audioWorkletNode = null;
  source = null;
  audioQueue = [];
  videoStream = null;
  videoInterval = null;
  isPlaying = false;
}

startBtn.addEventListener('click', startSession);
stopBtn.addEventListener('click', stopSession);

// Resize canvas
function resize() {
  canvas.width = canvas.parentElement.clientWidth;
  canvas.height = canvas.parentElement.clientHeight;
}
window.addEventListener('resize', resize);
resize();
drawVisualizer();
