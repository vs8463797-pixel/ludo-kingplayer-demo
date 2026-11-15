const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { loadData, saveData } = require("./store");

const app = express();
const PORT = process.env.PORT || 4000;

const UPLOAD_DIR = path.join(__dirname, "uploads");
const KYC_DIR = path.join(UPLOAD_DIR, "kyc");
fs.mkdirSync(KYC_DIR, { recursive: true });

app.use(cors());
app.use(express.json({ limit: "15mb" }));
app.use("/uploads", express.static(UPLOAD_DIR));
app.use(express.static(path.join(__dirname, "public")));

const otpStore = new Map();

function calculatePrize(entryAmount, commissionRate) {
  const totalPool = Number(entryAmount) * 2;
  return Number((totalPool * (1 - Number(commissionRate || 0))).toFixed(2));
}

// Send OTP to mobile/SIM
app.post("/api/auth/send-otp", (req, res) => {
  const cleanPhone = String(req.body.phone || "").trim();
  if (!cleanPhone) {
    return res.status(400).json({ error: "Mobile number daalein" });
  }

  const otp = String(Math.floor(100000 + Math.random() * 900000));
  otpStore.set(cleanPhone, { otp, expiresAt: Date.now() + 5 * 60 * 1000 });

  console.log(`OTP for ${cleanPhone}: ${otp}`);

  const includeDemoOtp = !process.env.SMS_GATEWAY_ENABLED;
  res.json({
    message: "OTP aapke number par bhej diya gaya hai",
    ...(includeDemoOtp ? { demoOtp: otp } : {})
  });
});

// Verify OTP and keep existing ID details
app.post("/api/auth/verify-otp", (req, res) => {
  const cleanPhone = String(req.body.phone || "").trim();
  const otp = String(req.body.otp || "").trim();
  const nameInput = String(req.body.name || "").trim();

  const record = otpStore.get(cleanPhone);
  if (!record || record.expiresAt < Date.now() || record.otp !== otp) {
    return res.status(400).json({ error: "OTP galat ya expire ho chuka hai" });
  }

  otpStore.delete(cleanPhone);
  const db = loadData();

  let user = db.users.find((u) => u.phone === cleanPhone);
  if (!user) {
    user = {
      id: "u_" + Date.now(),
      name: nameInput || `Player_${cleanPhone.slice(-4)}`,
      phone: cleanPhone,
      walletBalance: 0,
      bonusBalance: 0,
      kyc: {
        status: "not_submitted",
        kycName: "",
        docUrl: "",
        submittedAt: null
      },
      transactions: []
    };
    db.users.push(user);
    saveData(db);
  }

  res.json({ user, config: db.config });
});

// App state
app.get("/api/state", (req, res) => {
  res.json(loadData());
});

// One-time KYC submission for deposit
app.post("/api/kyc/submit", (req, res) => {
  const { userId, kycName, docBase64 } = req.body;
  if (!userId || !String(kycName || "").trim() || !docBase64) {
    return res.status(400).json({ error: "KYC naam aur document photo dono zaroori hain" });
  }

  const db = loadData();
  const user = db.users.find((u) => u.id === userId);
  if (!user) return res.status(404).json({ error: "User nahi mila" });

  const base64Data = docBase64.replace(/^data:image\/\w+;base64,/, "");
  const fileName = `kyc_${user.id}_${Date.now()}.png`;
  fs.writeFileSync(path.join(KYC_DIR, fileName), Buffer.from(base64Data, "base64"));

  user.kyc = {
    status: "pending",
    kycName: String(kycName).trim(),
    docUrl: `/uploads/kyc/${fileName}`,
    submittedAt: new Date().toISOString()
  };

  saveData(db);
  res.json({ user });
});

// Admin approve or reject KYC
app.post("/api/admin/kyc/:userId/review", (req, res) => {
  const { approve } = req.body;
  const db = loadData();
  const user = db.users.find((u) => u.id === req.params.userId);
  if (!user || !user.kyc) return res.status(404).json({ error: "KYC record nahi mila" });

  user.kyc.status = approve ? "approved" : "rejected";
  saveData(db);
  res.json({ user });
});

// Deposit (requires one-time approved KYC)
app.post("/api/wallet/deposit", (req, res) => {
  const { userId, amount, method, kycName } = req.body;
  const numAmount = Number(amount);
  if (!userId || !numAmount || numAmount <= 0) {
    return res.status(400).json({ error: "Sahi deposit amount daalein" });
  }

  const db = loadData();
  const user = db.users.find((u) => u.id === userId);
  if (!user) return res.status(404).json({ error: "User nahi mila" });

  if (!user.kyc || user.kyc.status !== "approved") {
    return res.status(403).json({
      code: "KYC_REQUIRED_FOR_DEPOSIT",
      error: "Deposit ke liye ek baar KYC submit aur admin se approve hona zaroori hai."
    });
  }

  if (kycName && user.kyc.kycName.toLowerCase() !== String(kycName).trim().toLowerCase()) {
    return res.status(400).json({
      error: "Deposit naam KYC registered naam ke mutabik hona chahiye."
    });
  }

  user.walletBalance = Number((user.walletBalance + numAmount).toFixed(2));
  user.transactions.unshift({
    id: "tx_" + Date.now(),
    type: "deposit",
    amount: numAmount,
    method: method || "UPI",
    status: "completed",
    createdAt: new Date().toISOString()
  });

  saveData(db);
  res.json({ user });
});

// Withdrawal request
app.post("/api/wallet/withdraw", (req, res) => {
  const { userId, amount, payoutDetails } = req.body;
  const numAmount = Number(amount);
  if (!userId || !numAmount || numAmount <= 0) {
    return res.status(400).json({ error: "Sahi withdrawal amount daalein" });
  }

  const db = loadData();
  const user = db.users.find((u) => u.id === userId);
  if (!user) return res.status(404).json({ error: "User nahi mila" });
  if (user.walletBalance < numAmount) {
    return res.status(400).json({ error: "Balance kam hai" });
  }

  user.walletBalance = Number((user.walletBalance - numAmount).toFixed(2));
  user.transactions.unshift({
    id: "wd_" + Date.now(),
    type: "withdrawal",
    amount: numAmount,
    payoutDetails: payoutDetails || "",
    status: "pending_admin_approval",
    createdAt: new Date().toISOString()
  });

  saveData(db);
  res.json({ user });
});

// Create manual battle table with creator name and automatic prize
app.post("/api/battles/create", (req, res) => {
  const { userId, entryAmount, modeId } = req.body;
  const entry = Number(entryAmount);
  if (!userId || !entry || entry <= 0) {
    return res.status(400).json({ error: "Sahi entry amount daalein" });
  }

  const db = loadData();
  const creator = db.users.find((u) => u.id === userId);
  if (!creator) return res.status(404).json({ error: "User nahi mila" });
  if (creator.walletBalance < entry) {
    return res.status(400).json({ error: "Wallet balance kam hai" });
  }

  creator.walletBalance = Number((creator.walletBalance - entry).toFixed(2));
  const prize = calculatePrize(entry, db.config.commissionRate);

  const battle = {
    id: "b_" + Date.now(),
    modeId: modeId || "ludo-classic",
    creatorId: creator.id,
    creatorName: creator.name,
    opponentId: null,
    opponentName: null,
    entry,
    prize,
    roomCode: "",
    status: "open",
    resultSubmission: null,
    createdAt: new Date().toISOString()
  };

  creator.transactions.unshift({
    id: "tx_" + Date.now(),
    type: "battle_entry",
    amount: -entry,
    battleId: battle.id,
    status: "completed",
    createdAt: new Date().toISOString()
  });

  db.battles.unshift(battle);
  saveData(db);
  res.json({ battle, user: creator });
});

// Join battle
app.post("/api/battles/:id/join", (req, res) => {
  const { userId } = req.body;
  const db = loadData();
  const battle = db.battles.find((b) => b.id === req.params.id);
  const joiner = db.users.find((u) => u.id === userId);

  if (!battle || !joiner) return res.status(404).json({ error: "Battle ya user nahi mila" });
  if (battle.status !== "open") return res.status(400).json({ error: "Battle ab open nahi hai" });
  if (battle.creatorId === joiner.id) {
    return res.status(400).json({ error: "Apni table khud join nahi kar sakte" });
  }
  if (joiner.walletBalance < battle.entry) {
    return res.status(400).json({ error: "Wallet balance kam hai" });
  }

  joiner.walletBalance = Number((joiner.walletBalance - battle.entry).toFixed(2));
  battle.opponentId = joiner.id;
  battle.opponentName = joiner.name;
  battle.status = "active";

  joiner.transactions.unshift({
    id: "tx_" + Date.now(),
    type: "battle_entry",
    amount: -battle.entry,
    battleId: battle.id,
    status: "completed",
    createdAt: new Date().toISOString()
  });

  saveData(db);
  res.json({ battle, user: joiner });
});

// Share room code
app.post("/api/battles/:id/room-code", (req, res) => {
  const db = loadData();
  const battle = db.battles.find((b) => b.id === req.params.id);
  if (!battle) return res.status(404).json({ error: "Battle nahi mila" });

  battle.roomCode = String(req.body.roomCode || "").trim();
  saveData(db);
  res.json({ battle });
});

// Submit Win/Lost + screenshot (waits for Admin confirmation)
app.post("/api/battles/:id/submit-result", (req, res) => {
  const { userId, outcome, screenshotBase64 } = req.body;
  if (!["win", "lost"].includes(outcome)) {
    return res.status(400).json({ error: "Win ya Lost chunein" });
  }
  if (!screenshotBase64) {
    return res.status(400).json({ error: "Winner screenshot upload karna zaroori hai" });
  }

  const db = loadData();
  const battle = db.battles.find((b) => b.id === req.params.id);
  const user = db.users.find((u) => u.id === userId);
  if (!battle || !user) return res.status(404).json({ error: "Record nahi mila" });

  const base64Data = screenshotBase64.replace(/^data:image\/\w+;base64,/, "");
  const fileName = `res_${battle.id}_${user.id}_${Date.now()}.png`;
  fs.writeFileSync(path.join(UPLOAD_DIR, fileName), Buffer.from(base64Data, "base64"));

  battle.status = "pending_admin_approval";
  battle.resultSubmission = {
    submittedByUserId: user.id,
    submittedByName: user.name,
    outcome,
    screenshotUrl: `/uploads/${fileName}`,
    adminDecision: "pending",
    submittedAt: new Date().toISOString()
  };

  saveData(db);
  res.json({ battle });
});

// Admin confirms or rejects match result -> updates balance only after confirmation
app.post("/api/admin/battles/:id/confirm", (req, res) => {
  const { approve } = req.body;
  const db = loadData();
  const battle = db.battles.find((b) => b.id === req.params.id);
  if (!battle || !battle.resultSubmission) {
    return res.status(404).json({ error: "Result submission nahi mila" });
  }

  if (approve) {
    const sub = battle.resultSubmission;
    const winnerId =
      sub.outcome === "win"
        ? sub.submittedByUserId
        : sub.submittedByUserId === battle.creatorId
        ? battle.opponentId
        : battle.creatorId;

    const winner = db.users.find((u) => u.id === winnerId);
    if (winner) {
      winner.walletBalance = Number((winner.walletBalance + battle.prize).toFixed(2));
      winner.transactions.unshift({
        id: "win_" + Date.now(),
        type: "battle_win",
        amount: battle.prize,
        battleId: battle.id,
        status: "completed",
        createdAt: new Date().toISOString()
      });
    }

    battle.status = "completed";
    battle.winnerId = winnerId;
    battle.resultSubmission.adminDecision = "approved";
  } else {
    battle.status = "rejected";
    battle.resultSubmission.adminDecision = "rejected";
  }

  saveData(db);
  res.json({ battle });
});

// Admin updates config/modes
app.post("/api/admin/config", (req, res) => {
  const { notice, commissionRate, modeId, modeStatus } = req.body;
  const db = loadData();

  if (typeof notice === "string" && notice.trim()) db.config.notice = notice.trim();
  if (commissionRate !== undefined && commissionRate !== "" && Number(commissionRate) >= 0) {
    db.config.commissionRate = Number(commissionRate);
  }
  if (modeId && modeStatus) {
    const mode = db.config.modes.find((m) => m.id === modeId);
    if (mode) mode.status = modeStatus;
  }

  saveData(db);
  res.json({ config: db.config });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
