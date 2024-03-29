var port = process.env.MYQ_SERVER_PORT || 8090
const { version: VERSION } = require('./package.json');
const axios = require('axios');
var express = require('express');
var app = express();
app.use(express.json());

const myQApi = require('@brbeaird/myq'); //Much thanks to hjdhjd for this
var myqEmail;
var myqPassword;
var myq; //Holds MyQ connection object
var myQDeviceMap = {} //Local cache of devices and their statuses
var searchPending = false;
var updateAvailable = false;
var reAuth = true;

const ssdpId = 'urn:SmartThingsCommunity:device:MyQController' //Used in SSDP auto-discovery


//Set credentials on myq object (these are always passed-in from calls from the ST hub)
async function validateMyqLogin(email, password){

  //Handle missing info
  if (!email || !password){
    log('Missing username or password.')
    return false;
  }

  //If password has been updated, set up new API object
  if (email != myqEmail || password != myqPassword){
    reAuth = true;
    log('Got new username/password from hub.');
    myqEmail = email;
    myqPassword = password;
  }

  return true;
}

/**Exposed Express routes */

//Gets devices
app.post('/devices', async (req, res) => {
  try {

    let email = req.body.auth.email;
    let password = req.body.auth.password;

    if (!validateMyqLogin(email, password)){
      return res.sendStatus(401);
    }

    //Connect. Note that the login call automatically calls refresh
    if (reAuth){
      myq = new myQApi.myQApi()
      await myq.login(email, password);
      reAuth = false;
    }
    else{
      await myq.refreshDevices();
    }

    if (!myq.accessToken){
      log(`MyQ login failed: ${myq.apiReturnStatus}`, 1);
      return res.sendStatus(401);
    }

    if (myq.apiReturnStatus != 200){
      log(`Refresh failed`, 1);
      throw new Error('refresh failed');
    }

    //Check for devices
    if (myq.devices && myq.devices.length > 0){
      let responseToHub = {
        meta: {
          version: VERSION,
          updateAvailable: updateAvailable
        },
        devices: myq.devices
      }
      res.send(responseToHub);
      for (let device of myq.devices){
        let cachedDevice = myQDeviceMap[device.serial_number];
          if (cachedDevice){
            let latestState = device.state.door_state ?? device.state.lamp_state;
            let oldState = cachedDevice.state.door_state ?? device.state.lamp_state;
            if (oldState != latestState && latestState){
              log(`Updating ${cachedDevice.name} state from ${oldState} to ${latestState}`);
            }
          }
        myQDeviceMap[device.serial_number] = JSON.parse(JSON.stringify(device));
      }
    }
    else{
      res.status(500).send('No devices found');
    }

  } catch (error) {
    log(`Refresh error: ${error.message}`, 1);
    res.status(500).send(error.message);
  }
})

//Controls a device
app.post('/:devId/control', async (req, res) => {
  try {
    if (!myq?.accessToken){
      log(`No active MyQ login session`, 1);
      return res.status(500).send('No myQ login token. Please try again after successful device refresh.')
    }

    let device = myQDeviceMap[req.params.devId];
    if (!device){
      return res.status(500).send('Error sending command - device not known. Please try again.')
    }

    log(`Sending ${req.body.command} command for ${device.name}`);
    let result = await myq.execute(device, req.body.command)
    if (result){
      res.sendStatus(200);
    }
    else{
      log(`Error Sending ${req.body.command} command for ${device.name}`, 1);
      res.status(500).send('Error sending command. Please try again.')
    }
  } catch (error) {
    res.status(500).send(error.message);
  }
})

//Status endpoint for troubleshooting
app.get('/status', async (req, res) => {
  try {
    if (!myq){
      return res.status(200).send('Awaiting login');
    }

    if (!myq.devices || myq.devices.length == 0){
      return res.status(200).send('No devices detected');
    }
    res.send(myq.devices);

  } catch (error) {
    log(`status error: ${error.message}`, 1);
    res.status(500).send(error.message);
  }
})

//Express webserver startup
let expressApp = app.listen(port, () => {
  port = expressApp.address().port
  log(`SmartThings MyQ Bridge server: Version: ${VERSION}`);
  log(`HTTP server listening on port ${port}`);
  startSsdp();
})

//Set up ssdp
function startSsdp() {
  var Server = require('node-ssdp-response').Server
  , server = new Server(
    {
        location: 'http://' + '0.0.0.0' + `:${port}/details`,
        udn: 'uuid:smartthings-brbeaird-myq',
          sourcePort: 1900,
        ssdpTtl: 2
    }
  );
  server.addUSN(ssdpId);
  server.start();
  log(`Auto-discovery module listening for SmartThings hub requests`);

  checkVersion();
  setInterval(() => {
    checkVersion();
  }, 1000*60*60); //Check every hour

  //I tweaked ssdp library to bubble up a broadcast event and to then do an http post to the URL
  // this is because this app cannot know its external IP if running as a docker container
  server.on('response', async function (headers, msg, rinfo) {
    try {
      if (searchPending || headers.ST != ssdpId || !headers.SERVER_IP || !headers.SERVER_PORT){
        return;
      }
      searchPending = true;
      let hubAddress = `http://${headers.SERVER_IP}:${headers.SERVER_PORT}/ping`
      log(`Detected auto-discovery request from SmartThings Hub (${hubAddress}). Replying with bridge server URL.`)
      await axios.post(hubAddress,
        {
          myqServerPort: port,
          deviceId: headers.DEVICE_ID
        },
        {timeout: 5000})
      log(`SmartThings hub acknowledged auto-discovery response. If this message repeats, it means the hub received the bridge server IP/Port but cannot connect to it due to firewall or network issues.`);
    } catch (error) {
        let msg = error.message;
        if (error.response){
          msg += error.response.data
      }
      log(msg, true);
    }
    searchPending = false;
  });
}

async function checkVersion(){
  try {
    let response = await axios.post('https://version.brbeaird.com/getVersion',
    {
      app: 'myqEdge',
      currentVersion: VERSION
    },
    {timeout: 15000})
  if (response.data?.version && response.data?.version != VERSION){
    updateAvailable = true;
    log(`Newer server version is available (${VERSION} => ${response.data?.version})`);
  }
  return;
  } catch (error) {}
}

//Logging with timestamp
function log(msg, isError) {
  let dt = new Date().toLocaleString();
  if (!isError) {
    console.log(dt + ' | ' + msg);
  }
  else{
    console.error(dt + ' | ' + msg);
  }
}
