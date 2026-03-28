let socket;
let audioContext;
let audioWorkletNode;
let source;
let isRunning = false;
let audioQueue = [];
let isPlaying = false;
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

    // 1. Initialize WebSocket
    const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${apiKey}`;
    socket = new WebSocket(url);

    socket.onopen = () => {
      console.log('WebSocket Opened');
      updateStatus('Connected', true);

      // Send Setup message
      const setupMsg = {
        setup: {
          model: "models/gemini-3.1-flash-live-preview",
          generation_config: {
            response_modalities: ["AUDIO"],
            speech_config: {
              voice_config: {
                prebuilt_voice_config: {
                  voice_name: "Puck"
                }
              }
            }
          },
          system_instruction: {
            parts: [{
              text: "You are a helpful, safety-conscious DIY assistant. You can see the user through their camera feed. Your job is to walk them through solving tasks by hand (like changing a car tire, fixing a faucet, etc.) step-by-step. Speak naturally, be encouraging, and give clear instructions based on exactly what you see in the video. If you see them doing something dangerous, warn them immediately. Keep your responses concise and focused on the current step."
            }]
          }
        }
      };
      socket.send(JSON.stringify(setupMsg));

      isRunning = true;
      startBtn.disabled = true;
      stopBtn.disabled = false;
      console.log('Setup Sent, waiting for setupComplete...');
    };

    socket.onmessage = async (event) => {
      const response = JSON.parse(event.data);
      console.log('Received Message', response);
      
      // 2. Handle Handshake Completion
      if (response.setupComplete) {
        console.log('Setup Complete! Starting media...');
        startCamera();
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
      if (event.code === 1000) {
        updateStatus('Disconnected');
      } else {
        updateStatus('Connection Closed');
        appendMessage('gemini', `Connection closed (Code: ${event.code}). This usually means an invalid API key, an incorrect Model ID, or a project permission issue.`);
      }
      stopSession();
    };

  } catch (error) {
    console.error('Session Start Failed', error);
    updateStatus('Failed to Start');
  }
}

async function startCamera() {
  try {
    videoStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 } }
    });
    cameraPreview.srcObject = videoStream;
    cameraStatus.textContent = 'Camera Live';
    cameraStatus.style.background = 'rgba(55, 178, 77, 0.6)';
  } catch (error) {
    console.error('Camera Access Failed', error);
    appendMessage('gemini', 'Error: Could not access camera.');
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
    realtime_input: {
      media_chunks: [
        {
          mime_type: "image/jpeg",
          data: base64
        }
      ]
    }
  };
  socket.send(JSON.stringify(msg));
}

async function startAudio() {
  try {
    audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });

    await audioContext.audioWorklet.addModule('audio-worklet-processor.js');

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

    // Check if session was stopped while waiting for mic permission
    if (!audioContext || !isRunning) {
      stream.getTracks().forEach(track => track.stop());
      return;
    }

    source = audioContext.createMediaStreamSource(stream);

    audioWorkletNode = new AudioWorkletNode(audioContext, 'pcm-processor');

    audioWorkletNode.port.onmessage = (event) => {
      if (socket && socket.readyState === WebSocket.OPEN) {
        const base64 = btoa(String.fromCharCode(...new Uint8Array(event.data)));
        const msg = {
          realtime_input: {
            media_chunks: [
              {
                mime_type: "audio/pcm;rate=16000",
                data: base64
              }
            ]
          }
        };
        socket.send(JSON.stringify(msg));
      }
    };

    source.connect(audioWorkletNode);
    audioWorkletNode.connect(audioContext.destination); // Required for some browsers to keep it alive

    appendMessage('gemini', 'Listening... Talk to me!');

  } catch (error) {
    console.error('Audio Setup Failed', error);
    appendMessage('gemini', 'Error: Could not access microphone.');
  }
}

function enqueueAudio(base64) {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Int16Array(len / 2);
  for (let i = 0; i < len; i += 2) {
    bytes[i / 2] = (binaryString.charCodeAt(i + 1) << 8) | binaryString.charCodeAt(i);
  }

  audioQueue.push(bytes);
  if (!isPlaying) {
    playNextChunk();
  }
}

async function playNextChunk() {
  if (audioQueue.length === 0) {
    isPlaying = false;
    return;
  }

  isPlaying = true;
  const chunk = audioQueue.shift();

  // Convert Int16 PCM to Float32 for Web Audio
  const float32 = new Float32Array(chunk.length);
  for (let i = 0; i < chunk.length; i++) {
    float32[i] = chunk[i] / 0x7FFF;
  }

  const buffer = audioContext.createBuffer(1, float32.length, 24000); // Response is usually 24kHz
  buffer.getChannelData(0).set(float32);

  const bufferSource = audioContext.createBufferSource();
  bufferSource.buffer = buffer;
  bufferSource.connect(audioContext.destination);
  bufferSource.start();

  bufferSource.onended = () => {
    playNextChunk();
  };
}

function stopSession() {
  isRunning = false;
  startBtn.disabled = false;
  stopBtn.disabled = true;

  if (socket) socket.close();
  if (source) source.mediaStream.getTracks().forEach(track => track.stop());
  if (videoStream) videoStream.getTracks().forEach(track => track.stop());
  if (audioContext) audioContext.close();
  if (videoInterval) clearInterval(videoInterval);

  cameraPreview.srcObject = null;
  cameraStatus.textContent = 'Camera Off';
  cameraStatus.style.background = 'rgba(0, 0, 0, 0.6)';

  socket = null;
  audioContext = null;
  audioWorkletNode = null;
  source = null;
  audioQueue = [];
  videoStream = null;
  videoInterval = null;
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
