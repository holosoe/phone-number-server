const assert = require("assert");
const axios = require("axios");
const { issue, getAddress } = require("holonym-wasm-issuer");
const express = require("express");
const cors = require("cors");
const { addNumber, numberExists } = (require("./dynamodb.js"));
const { begin, verify } = require("./otp.js");
const PhoneNumber = require('libphonenumber-js');

require("dotenv").config();
const client = require("twilio")(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const app = express();
app.use(cors({origin: ["https://holonym.id", "https://www.holonym.id","https://app.holonym.id","http://localhost:3000","http://localhost:3001","http://localhost:3002"]}));
const port = 3030;
const MAX_FRAUD_SCORE = 75; // ipqualityscore.com defines fraud score. This constant will be used to only allow phone numbers with a <= fraud score.

const PRIVKEY = process.env[`${
    (
        (process.env.DISABLE_SYBIL_RESISTANCE_FOR_TESTING) && 
        (process.env.DISABLE_SYBIL_RESISTANCE_FOR_TESTING === "true")
    ) ? "TESTING" : "PRODUCTION"
}_PRIVKEY`];

const ADDRESS = getAddress(PRIVKEY);

// Sends a new code to number (E.164 format e.g. +13109273149)
app.get("/send/v3/:number", async (req, res) => {
    console.log("sending to ", req.params.number)
    const countryCode = getCountryFromPhoneNumber(req.params.number);
    await begin(req.params.number, countryCode)
    res.sendStatus(200)
})

function getCountryFromPhoneNumber(phoneNumber) {
    try {
        const parsedPhoneNumber = PhoneNumber(phoneNumber);
        const countryCode = parsedPhoneNumber.country;

        return countryCode;
    } catch(err) {
        console.error('Error parsing phone number:', err);
        next(err.message)
    }
}

// Sends a new code to number (E.164 format e.g. +13109273149)
app.get("/send/:number", (req, res) => {
    // req.setTimeout(5000); // Will timeout if no response from Twilio after 5s
    console.log("sending to ", req.params.number)
    client.verify.v2.services(process.env.TWILIO_SERVICE_SID)
                .verifications
                .create({to: req.params.number, channel: "sms"})
                .then(() => {res.status(200);return;});
                
})

// Checks that user-provided code is the one that was sent to number, and if so, and if number is safe and not used before, returns credentials
app.get("/getCredentials/v2/:number/:code/:country/", (req, res, next) => {
    req.setTimeout(10000); // Will timeout if no response from Twilio after 10s
    console.log("getCredentials v2 was called ")
    client.verify.v2.services(process.env.TWILIO_SERVICE_SID)
            .verificationChecks
            .create({to: req.params.number, code: req.params.code})
            .then(verification => {
                if(verification.status !== "approved"){next("There was a problem verifying the number with the code provided")}
                registerAndGetCredentialsIfSafe("v2", req.params.number, req.params.country, next, (credentials)=>{res.send(credentials); return}, )
            }).catch(err => {
                console.log('getCredentials v2: error', err)
                next("There was a problem verifying the number with the code provided")
            });
})

// Checks that user-provided code is the one that was sent to number, and if so, and if number is safe and not used before, returns credentials
app.get("/getCredentials/v3/:number/:code/:country/", async (req, res, next) => {
    req.setTimeout(10000); 
    console.log("getCredentials v3 was called for number",req.params.number)
    let result = false;
    
    try { 
        result = await verify(req.params.number, req.params.code)
        if(result) {
            registerAndGetCredentialsIfSafe("doesnt_matter", req.params.number, req.params.country, next, (credentials)=>{res.send(credentials); return})
        }
        
    } catch (err) {
        console.log('getCredentials v3: error', err)
        next(err.message)
    }
})

// Express error handling
app.use(function (err, req, res, next) {
    console.log("error: ", err);
    res.status(err.status || 500).send(err);
    return;
  });

/* Functions */

async function credsFromNumber(phoneNumberWithPlus) {
    console.log("credsFromNumber was called with number ", phoneNumberWithPlus)
    const phoneNumber = phoneNumberWithPlus.replace("+", "");
    return issue(PRIVKEY, phoneNumber, "0");
}

function registerAndGetCredentialsIfSafe(version, phoneNumber, country, next, callback) {
    // let credsFromNumber = version == "v2" ? credsFromNumberV2 : credsFromNumberDeprecating
    console.log("registerAndGetCredentialsIfSafe was called")
    assert(phoneNumber && country);
    try {
        registerIfSafe(phoneNumber, country, next, (isSafe) => {
            if (!isSafe) {
                console.log(`phone number ${phoneNumber} could not be determined to belong to a unique human`)
                next("phone number could not be determined to belong to a unique human")
            } else {
                credsFromNumber(phoneNumber).then(creds => callback(creds));
            }
        });
    } catch (error) {
        console.error("error", error)
        next(error);
    }
    
}

function registerIfSafe(phoneNumber, country, next, callback) {
    try {
        assert(phoneNumber && country);
        axios.get(`https://ipqualityscore.com/api/json/phone/${process.env.IPQUALITYSCORE_APIKEY}/${phoneNumber}?country[]=${country}`)
        .then((response) => {
            if(!("fraud_score" in response?.data)) {next(`Invalid response: ${JSON.stringify(response)} `)}
            numberExists(phoneNumber, (err, result) => {
                console.log("is registered", result);
                if(result && !process.env.DISABLE_SYBIL_RESISTANCE_FOR_TESTING) {next("Number has been registered already!"); return}
                // Allow disabling of Sybil resistance for testing this script can be tested more than once ;)
                if(!process.env.DISABLE_SYBIL_RESISTANCE_FOR_TESTING){
                    addNumber(phoneNumber);
                }
                callback(response.data.fraud_score <= MAX_FRAUD_SCORE);
            })  
        })
    } catch(err) { next(err) }
    
}

/* - */
app.listen(port);
// holonym twilio number: +18312329705
