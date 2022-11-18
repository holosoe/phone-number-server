const assert = require("assert");
const axios = require("axios");
const { randomBytes } = require("crypto");
const { ethers } = require("ethers");
const { poseidon } = require("circomlibjs-old");
require("dotenv").config();
const client = require("twilio")(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const dbConfig = process.env.NO_DB_ACCESS || require("../phone-number-db.config.js");
const mysql = require("mysql");
const express = require("express");

const app = express();
const port = 3030;
const MAX_FRAUD_SCORE = 2; // ipqualityscore.com defines fraud score. This constant will be used to only allow phone numbers with a <= fraud score.

let connection;
if(!process.env.NO_DB_ACCESS){
    connection = mysql.createConnection({
        host: dbConfig.HOST,
        user: dbConfig.USER,
        password: dbConfig.PASSWORD,
        database: dbConfig.DB
      });
      connection.connect(error => {
          if (error) throw error;
          console.log("Successfully connected to database");
      });
}


// Sends a new code to number (E.164 format e.g. +13109273149)
app.get("/send/:number", (req, res) => {
    req.setTimeout(5000); // Will timeout if no response from Twilio after 5s

    client.verify.v2.services(process.env.TWILIO_SERVICE_SID)
                .verifications
                .create({to: req.params.number, channel: "sms"})
                .then(() => res.status(200));
})

// Checks that user-provided code is the one that was sent to number, and if so, and if number is safe and not used before, returns credentials
app.get("/getCredentials/:number/:code/:country", (req, res) => {
    req.setTimeout(5000); // Will timeout if no response from Twilio after 5s

    client.verify.v2.services(process.env.TWILIO_SERVICE_SID)
                .verificationChecks
                .create({to: req.params.number, code: req.params.code})
                .then(verification => {
                    if(verification.status !== "approved"){throw "There was a problem verifying the with the code provided"}
                    getCredentialsIfSafe(req.params.number, req.params.country, (credentials)=>res.send(credentials))
                });

})

/* Functions */
async function credsFromNumber(phoneNumberWithPlus) {
    const phoneNumber = phoneNumberWithPlus.replace("+", "");
    const issuer = process.env.PHONENO_ISSUER_ADDRESS;
    const secret = "0x" + randomBytes(16).toString("hex");
    const completedAt = Math.ceil(Date.now() / 1000) + 2208988800; // 2208988800000 is 70 year offset; Unix timestamps below 1970 are negative and we want to allow dates starting at 1900. Hence, all Holonym dates start at 01/01/1900 rather than Unix 01/01/1970
    assert.equal(issuer.length, 42, "invalid issuer");
    assert.equal(secret.length, 34, "invalid secret");
    
    const leaf = poseidon([
           issuer, secret, phoneNumber, completedAt, 0, 0
         ].map((x) => ethers.BigNumber.from(x).toString())
    );
    const signature = await signLeaf(leaf);
    
    return { 
        phoneNumber: phoneNumber, 
        issuer : issuer, 
        secret : secret, 
        completedAt : completedAt,
        signature : signature
     };
}

async function signLeaf(leaf) {
    const signable = ethers.utils.arrayify(ethers.BigNumber.from(leaf));
    const wallet = new ethers.Wallet(process.env.PHONENO_ISSUER_PRIVATE_KEY);
    const signature = await wallet.signMessage(signable);
    return signature;
}

function getCredentialsIfSafe(phoneNumber, country, callback) {
    assert(phoneNumber && country);
    getIsSafe(phoneNumber, country, (isSafe) => {
        if (!isSafe) throw "phone number could not be determined to belong to a unique human";
        credsFromNumber(phoneNumber).then(creds => callback(creds));
    });
}

function getIsSafe(phoneNumber, country, callback) {
    assert(phoneNumber && country);
    axios.get(`https://ipqualityscore.com/api/json/phone/${process.env.IPQUALITYSCORE_APIKEY}/${phoneNumber}?country[]=${country}`)
    .then((response) => {
        if(!("fraud_score" in response?.data)) {throw `Invalid response: ${JSON.stringify(response)} `}
        _getNumberIsRegistered(phoneNumber, (result) => {
            console.log("is registered", result);
            if(result) {throw "Number has been registered already!"}
            _setNumberIsRegistered(phoneNumber);
            callback(response.data.fraud_score <= MAX_FRAUD_SCORE);
        })  
    })
}


function _setNumberIsRegistered(number, callback) {
    connection.query(`INSERT INTO PhoneNumbers Number) VALUES ('${number}')`, (err, result) => {callback(err,result)});
}

function _getNumberIsRegistered(number, callback) {
    connection.query(`SELECT Number FROM PhoneNumbers WHERE Number='${number}'`, (err, result) => {callback(err, result)});
}



/* - */
app.listen(port);
// holonym twilio number: +18312329705
