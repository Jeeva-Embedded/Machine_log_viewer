// BlowCard (machine 2) — spec & layout. Debug THIS machine here.
window.MACHINE_CONFIG = window.MACHINE_CONFIG || {};
window.MACHINE_DEFS   = window.MACHINE_DEFS   || {};

window.MACHINE_CONFIG[2] = {name:'BlowCard',  sub:'CAN2 · 192.168.1.125:2001 · Cylinder / Beater / Coiler + 5 others',     can:'CAN2',port:2001};

window.MACHINE_DEFS[2] = { // BlowCard (Carding-MainBoard_v8) — 8 motors, no AutoLeveller
    // Addresses: 0x02=Cylinder 0x03=Beater 0x04=Cage 0x05=CardFeed
    //            0x06=BeaterFeed 0x07=Coiler 0x08=AFCylinder 0x09=AFFeed
    addrMap:{0x01:'MB',0x02:'Cylinder',0x03:'Beater',0x04:'Cage',
             0x05:'CardFeed',0x06:'BeaterFeed',0x07:'Coiler',0x08:'AFCyl',0x09:'AFFeed'},
    motorMap:{0x02:'fr',0x03:'br',0x04:'cr',0x05:'m4',0x06:'m5',0x07:'m6',0x08:'m7',0x09:'m8'},
    motorNames:{fr:'Cylinder',br:'Beater',cr:'Cage',m4:'Card Feed',m5:'Beater Feed',m6:'Coiler',m7:'Picker Cylinder',m8:'AF Feed'},
    setupLabels:{fr:'Cylinder',br:'Beater',cr:'Cage'},
    extraMotors:['m4','m5','m6','m7','m8'], // all 8 carding motors
    fnMap:{0x01:'MotorState',0x02:'Error',0x03:'DriveCheck',0x04:'DriveCheckResp',
           0x06:'DataReq',0x07:'RunSetup',0x08:'AnalysisData',0x09:'RuntimeData',
           0x0A:'Diagnostics',0x0B:'CylExtData',0x0D:'ChangeTarget',0x0F:'ACK',
           0x14:'DiagDone',0x18:'DriveCANChk'},
    hasAL:false, hasLifts:false, errorBytes:3,
    // RunSetup: 4 bytes [RUT(1), RDT(1), RPM_H, RPM_L] — same as DrawFrame
    // Extended data 0x0B: Cylinder & Beater only (32 bytes)
  };
