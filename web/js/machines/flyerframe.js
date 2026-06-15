// FlyerFrame (machine 3) — spec & layout. Debug THIS machine here.
window.MACHINE_CONFIG = window.MACHINE_CONFIG || {};
window.MACHINE_DEFS   = window.MACHINE_DEFS   || {};

window.MACHINE_CONFIG[3] = {name:'FlyerFrame',sub:'CAN3 · 192.168.1.125:3001 · Flyer / Bobbin / Front Roller + Lifts',     can:'CAN3',port:3001};

window.MACHINE_DEFS[3] = { // FlyerFrame (MainBoard_Flyer01_v8) — 6 motors (4 spin + 2 lift), no AutoLeveller
    // Addresses: 0x02=Flyer 0x03=Bobbin 0x04=LeftLift 0x05=RightLift
    //            0x06=FrontRoller 0x07=BackRoller
    addrMap:{0x01:'MB',0x02:'Flyer',0x03:'Bobbin',0x04:'L.Lift',
             0x05:'R.Lift',0x06:'FrontRoller',0x07:'BackRoller'},
    motorMap:{0x02:'fr',0x03:'br',0x06:'cr',0x07:'m4'}, // Flyer, Bobbin, FrontRoller, BackRoller
    liftMap: {0x04:'ll',0x05:'rl'},
    motorNames:{fr:'Flyer',br:'Bobbin',cr:'Front Roller',m4:'Back Roller'},
    setupLabels:{fr:'Flyer',br:'Bobbin',cr:'Front Roller'},
    extraMotors:['m4'],
    fnMap:{0x01:'MotorState',0x02:'Error',0x03:'DriveCheck',0x04:'DriveCheckResp',
           0x05:'SetupCallback',0x06:'TuningData',0x07:'RunSetup',0x08:'AnalysisData',
           0x09:'RuntimeData',0x0A:'Diagnostics',0x0C:'LiftRuntime',0x0D:'ChangeTarget',
           0x0E:'LiftStrokeOver',0x0F:'ACK',0x10:'LiftRunSetup',0x11:'LiftDiagnostics',
           0x13:'HomingDone',0x14:'DiagDone',0x15:'LiftNewStroke',0x16:'LiftSendGB',
           0x17:'LiftGBData',0x18:'DriveCANChk',0x1B:'PIDUpdateResp',0x1C:'BackRollerSettings'},
    hasAL:false, hasLifts:true, errorBytes:3,
    // RunSetup (0x07): 4 bytes [RUT(1), RDT(1), RPM_H, RPM_L] — same as DrawFrame
    // LiftRunSetup (0x10): 12 bytes [StrokeLen(2), StrokeTime(2), Dir, LiftRUT, LiftRDT, LiftCRT(2)]
    // LiftRuntime (0x0C): 20 bytes [TPOS(2), PPOS(2), RPM(2), PWM(2), FET, MOT, Curr(2), Volt(2), pad, GBPos(2), EncPos(2), UsingPos]
  };
