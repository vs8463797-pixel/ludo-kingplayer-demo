const fs = require("fs");
const path = require("path");

const DATA_FILE = path.join(__dirname, "data.json");

const initialData = {
  config: {
    notice: "डिपॉजिट और विड्रॉल केवाईसी के नाम से करें वरना आईडी ब्लॉक कर दी जाएगी।",
    referralText: "1% COMMISSION — Invite friends and earn",
    commissionRate: 0.05,
    modes: [
      { id: "ludo-classic", title: "LUDO CLASSIC", status: "live" },
      { id: "1-goti-ludo", title: "1 GOTI LUDO", status: "coming_soon" }
    ]
  },
  users: [
    {
      id: "u_1001",
      name: "Ramglesh",
      phone: "9999999991",
      walletBalance: 25.5,
      bonusBalance: 0,
      kyc: {
        status: "not_submitted",
        kycName: "",
        docUrl: "",
        submittedAt: null
      },
      transactions: []
    }
  ],
  battles: []
};

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(initialData, null, 2));
  }
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

module.exports = { loadData, saveData };
