// DrawFrame (machine 1) — spec & layout. Debug THIS machine here.
window.MACHINE_CONFIG = window.MACHINE_CONFIG || {};
window.MACHINE_DEFS   = window.MACHINE_DEFS   || {};

window.MACHINE_CONFIG[1] = {name:'DrawFrame', sub:'CAN1 · 192.168.1.125:1001 · Front Roller / Back Roller / Creel',        can:'CAN1',port:1001};

window.MACHINE_DEFS[1] = { // DrawFrame — Carding-MainBoard variant with AutoLeveller
    addrMap:{0x01:'MB',0x02:'FR',0x03:'BR',0x04:'CREEL',0x0A:'AL'},
    motorMap:{0x02:'fr',0x03:'br',0x04:'cr'},
    motorNames:{fr:'Front Roller',br:'Back Roller',cr:'Creel'},
    setupLabels:{fr:'Front Roller',br:'Back Roller',cr:'Creel'},
    fnMap:{0x01:'MotorState',0x02:'Error',0x07:'RunSetup',0x09:'RuntimeData',
           0x0A:'Diagnostics',0x0F:'ACK',0x1E:'AL_Sensor',0x1F:'AL_Setup',0x20:'ACK',0x24:'AL_Settings'},
    hasAL:true, hasLifts:false, errorBytes:2,
    // RunSetup: 4 bytes [RUT(1), RDT(1), RPM_H, RPM_L]
  };
