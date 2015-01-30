var Promise   = require('promise');
var debug     = require('debug')('routes:api:v1');
var slugid    = require('slugid');
var assert    = require('assert');
var _         = require('lodash');
var base      = require('taskcluster-base');

// Common schema prefix
var SCHEMA_PREFIX_CONST = 'http://schemas.taskcluster.net/queue/v1/';

/** API end-point for version v1/
 *
 * In this API implementation we shall assume the following context:
 * {
 *   Task:           // data.Task instance
 *   Artifacts:      // data.Task instance
 *   publisher:      // publisher from base.Exchanges
 *   validator:      // base.validator
 *   claimTimeout:   // Number of seconds before a claim expires
 *   queueService:   // Azure QueueService object from queueservice.js
 * }
 */
var api = new base.API({
  title:        "Queue API Documentation",
  description: [
    "The queue, typically available at `queue.taskcluster.net`, is responsible",
    "for accepting tasks and track their state as they are executed by",
    "workers. In order ensure they are eventually resolved.",
    "",
    "This document describes the API end-points offered by the queue. These ",
    "end-points targets the following audience:",
    " * Schedulers, who create tasks to be executed,",
    " * Workers, who execute tasks, and",
    " * Tools, that wants to inspect the state of a task."
  ].join('\n')
});

// List of slugid parameters
var SLUGID_PARAMS = [
  'taskId'
];

// List of identifier parameters
var IDENTIFIER_PARAMS = [
  'provisionerId',
  'workerType',
  'workerGroup',
  'workerId'
];

// List of integer parameters
var INT_PARAMS = [
  'runId'
];

/**
 * Check parameters against regular expressions for identifiers
 * and send a 401 response with an error in case of malformed URL parameters
 *
 * returns true if there was no errors.
 */
var checkParams = function(req, res) {
  var errors = [];
  _.forIn(req.params, function(value, key) {
    // Validate slugid parameters
    if (SLUGID_PARAMS.indexOf(key) !== -1) {
      if (!/^[a-zA-Z0-9-_]{22}$/.test(value)) {
        errors.push({
          message:  "Parameter '" + key + "' is not a slugid",
          error:    value
        });
      }
    }

    // Validate identifier parameters
    if (IDENTIFIER_PARAMS.indexOf(key) !== -1) {
      // Validate format
      if (!/^[a-zA-Z0-9-_]*$/.test(value)) {
        errors.push({
          message:  "Parameter '" + key + "' does not match [a-zA-Z0-9-_]* " +
                    "as required for identifiers",
          error:    value
        });
      }

      // Validate minimum length
      if (value.length == 0) {
        errors.push({
          message:  "Parameter '" + key + "' must be longer than 0 characters",
          error:    value
        });
      }

      // Validate maximum length
      if (value.length > 22) {
        errors.push({
          message:  "Parameter '" + key + "' cannot be more than 22 characters",
          error:    value
        });
      }
    }

    // Validate and parse integer parameters
    if (INT_PARAMS.indexOf(key) !== -1) {
      if (!/^[0-9]+$/.test(value)) {
        errors.push({
          message:  "Parameter '" + key + "' does not match [0-9]+",
          error:    value
        });
      } else {
        var number = parseInt(value);
        if (_.isNaN(number)) {
          errors.push({
            message:  "Parameter '" + key + "' parses to NaN",
            error:    value
          });
        }
      }
    }
  });

  // Check for errors and reply if necessary
  if (errors.length != 0) {
    res.status(401).json({
      message:  "Malformed URL parameters",
      error:    errors
    });
    return false;
  }
  // No errors
  return true;
};

// Export checkParams for use in artifacts.js
api.checkParams = checkParams;

// Export api
module.exports = api;

/** Create tasks */
api.declare({
  method:     'put',
  route:      '/task/:taskId',
  name:       'createTask',
  idempotent: true,
  scopes:     ['queue:create-task:<provisionerId>/<workerType>'],
  deferAuth:  true,
  input:      SCHEMA_PREFIX_CONST + 'create-task-request.json#',
  output:     SCHEMA_PREFIX_CONST + 'task-status-response.json#',
  title:      "Create New Task",
  description: [
    "Create a new task, this is an **idempotent** operation, so repeat it if",
    "you get an internal server error or network connection is dropped.",
    "",
    "**Task `deadline´**, the deadline property can be no more than 7 days",
    "into the future. This is to limit the amount of pending tasks not being",
    "taken care of. Ideally, you should use a much shorter deadline.",
    "",
    "**Task specific routing-keys**, using the `task.routes` property you may",
    "define task specific routing-keys. If a task has a task specific ",
    "routing-key: `<route>`, then the poster will be required to posses the",
    "scope `queue:route:<route>`. And when the an AMQP message about the task",
    "is published the message will be CC'ed with the routing-key: ",
    "`route.<route>`. This is useful if you want another component to listen",
    "for completed tasks you have posted."
  ].join('\n')
}, function(req, res) {
  // Validate parameters
  if (!checkParams(req, res)) {
    return;
  }

  var ctx = this;
  var taskId  = req.params.taskId;
  var taskDef = req.body;

  // Find scopes required for task specific routes
  var routeScopes = taskDef.routes.map(function(route) {
    return 'queue:route:' + route;
  });

  // Authenticate request by providing parameters, and then validate that the
  // requester satisfies all the scopes assigned to the task
  if (!req.satisfies({
    provisionerId:  taskDef.provisionerId,
    workerType:     taskDef.workerType
  }) || !req.satisfies([taskDef.scopes])
     || !req.satisfies([routeScopes])) {
    return;
  }

  // Set created, if not provided
  var match = undefined;
  if (taskDef.created === undefined) {
    taskDef.created = new Date();
    match = function(data) {
      if (data.version !== 1) {
        return false;
      }
      taskDef. Date((data.definition || {}).created);

    };
  }

  // Set taskGroupId to taskId if not provided
  if (!taskDef.taskGroupId) {
    taskDef.taskGroupId = taskId;
  }

  // Validate that deadline is less than a week from now
  var aWeekFromNow = new Date();
  aWeekFromNow.setDate(aWeekFromNow.getDate() + 8);
  if (new Date(taskDef.deadline) > aWeekFromNow) {
    return res.status(400).json({
      message:    "Deadline cannot be more than 1 week into the future",
      error: {
        deadline: taskDef.deadline
      }
    });
  }

  // Conditional put to azure blob storage
  return ctx.taskstore.putOrMatch(taskId + '/task.json', {
    version:    1,
    definition: taskDef
  }).then(function() {
    // Create task in database, load it if it exists, task creation should be
    // an idempotent operation
    return ctx.Task.create({
      version:        1,
      taskId:         taskId,
      provisionerId:  taskDef.provisionerId,
      workerType:     taskDef.workerType,
      schedulerId:    taskDef.schedulerId,
      taskGroupId:    taskDef.taskGroupId,
      created:        taskDef.created,
      deadline:       taskDef.deadline,
      retriesLeft:    taskDef.retries,
      routes:         taskDef.routes,
      owner:          taskDef.metadata.owner,
      runs: [
        {
          runId:          0,
          state:          'pending',
          reasonCreated:  'scheduled',
          scheduled:      new Date().toJSON()
        }
      ]
    }, true).then(function(task) {
      // Publish message about a defined task
      return ctx.publisher.taskDefined({
        status:         task.status()
      }, task.routes).then(function() {
        // Put message in appropriate azure queue
        return ctx.queueService.putTask(
          taskDef.provisionerId,
          taskDef.workerType,
          taskId,
           _.last(task.runs).runId,
          new Date(taskDef.deadline)
        );
      }).then(function() {
        // Publish message about a pending task
        return ctx.publisher.taskPending({
          status:         task.status(),
          runId:          _.last(task.runs).runId
        }, task.routes);
      }).then(function() {
        // Reply to caller
        debug("New task created: %s", taskId);
        return res.reply({
          status:       task.status()
        });
      });
    });
  }, function(err) {
    // Handle error in case the taskId is already in use, with another task
    // definition
    if (err.code == 'BlobAlreadyExists') {
      return res.status(409).json({
        message:      "taskId already used by another task"
      });
    }
    throw err;
  });
});

/** Get task */
api.declare({
  method:     'get',
  route:      '/task/:taskId',
  name:       'getTask',
  idempotent: true,
  scopes:     undefined,
  output:     SCHEMA_PREFIX_CONST + 'task.json#',
  title:      "Fetch Task",
  description: [
    "Get task definition from queue."
  ].join('\n')
}, function(req, res) {
  // Validate parameters
  if (!checkParams(req, res)) {
    return;
  }

  var ctx = this;
  var taskId  = req.params.taskId;

  // Fetch task from azure blob storage
  return ctx.taskstore.get(taskId + '/task.json', true).then(function(data) {
    // Handle case where task doesn't exist
    if (!data) {
      return res.status(409).json({
        message:  "task not found"
      });
    }
    // Check version of data stored
    assert(data.version === 1, "version 1 was expected, don't know how to " +
           "read newer versions");

    if (!data.definition.extra) {
      console.error('fked up task %s', taskId);
      data.definition.extra = {};
    }
    // Return task definition
    return res.reply(data.definition);
  });
});

/** Define tasks */
api.declare({
  method:     'post',
  route:      '/task/:taskId/define',
  name:       'defineTask',
  scopes:     [
    'queue:define-task:<provisionerId>/<workerType>',
    'queue:create-task:<provisionerId>/<workerType>'
  ],
  deferAuth:  true,
  input:      SCHEMA_PREFIX_CONST + 'create-task-request.json#',
  output:     SCHEMA_PREFIX_CONST + 'task-status-response.json#',
  title:      "Define Task",
  description: [
    "Define a task without scheduling it. This API end-point allows you to",
    "upload a task definition without having scheduled. The task won't be",
    "reported as pending until it is scheduled, see the scheduleTask API ",
    "end-point.",
    "",
    "The purpose of this API end-point is allow schedulers to upload task",
    "definitions without the tasks becoming _pending_ immediately. This useful",
    "if you have a set of dependent tasks. Then you can upload all the tasks",
    "and when the dependencies of a tasks have been resolved, you can schedule",
    "the task by calling `/task/:taskId/schedule`. This eliminates the need to",
    "store tasks somewhere else while waiting for dependencies to resolve.",
    "",
    "**Note** this operation is **idempotent**, as long as you upload the same",
    "task definition as previously defined this operation is safe to retry."
  ].join('\n')
}, function(req, res) {
  // Validate parameters
  if (!checkParams(req, res)) {
    return;
  }

  var ctx = this;
  var taskId  = req.params.taskId;
  var taskDef = req.body;

  // Find scopes required for task-specific routes
  var routeScopes = taskDef.routes.map(function(route) {
    return 'queue:route:' + route;
  });

  // Authenticate request by providing parameters, and then validate that the
  // requester satisfies all the scopes assigned to the task
  if(!req.satisfies({
    provisionerId:  taskDef.provisionerId,
    workerType:     taskDef.workerType
  }) || !req.satisfies([taskDef.scopes])
     || !req.satisfies([routeScopes])) {
    return;
  }

  // Validate that deadline is less than a week from now
  var aWeekFromNow = new Date();
  aWeekFromNow.setDate(aWeekFromNow.getDate() + 8);
  if (new Date(taskDef.deadline) > aWeekFromNow) {
    return res.status(409).json({
      message:    "Deadline cannot be more than 1 week into the future",
      error: {
        deadline: taskDef.deadline
      }
    });
  }

  // Set taskGroupId to taskId if not provided
  if (!taskDef.taskGroupId) {
    taskDef.taskGroupId = taskId;
  }

  // Conditional put to azure blob storage
  return ctx.taskstore.putOrMatch(taskId + '/task.json', {
    version:    1,
    definition: taskDef
  }).then(function() {
    // Create task in database, load it if it exists, task creation should be
    // an idempotent operation
    return ctx.Task.create({
      version:        1,
      taskId:         taskId,
      provisionerId:  taskDef.provisionerId,
      workerType:     taskDef.workerType,
      schedulerId:    taskDef.schedulerId,
      taskGroupId:    taskDef.taskGroupId,
      created:        taskDef.created,
      deadline:       taskDef.deadline,
      retriesLeft:    taskDef.retries,
      routes:         taskDef.routes,
      owner:          taskDef.metadata.owner,
      runs:           []
    }, true);
  }).then(function(task) {
    // Publish message about a defined task
    return ctx.publisher.taskDefined({
      status:         task.status()
    }, task.routes).then(function() {
      // Reply to caller
      debug("New task defined: %s", taskId);
      return res.reply({
        status:       task.status()
      });
    });
  }).catch(function(err) {
    // Handle error in case the taskId is already in use, with another task
    // definition
    if (err.code === 'BlobAlreadyExists') {
      return res.status(409).json({
        message:      "taskId already used by another task"
      });
    }
    throw err;
  });
});



/** Schedule previously defined tasks */
api.declare({
  method:     'post',
  route:      '/task/:taskId/schedule',
  name:       'scheduleTask',
  scopes:     [
    [
      'queue:schedule-task',
      'assume:scheduler-id:<schedulerId>/<taskGroupId>'
    ]
  ],
  deferAuth:  true,
  input:      undefined, // No input accepted
  output:     SCHEMA_PREFIX_CONST + 'task-status-response.json#',
  title:      "Schedule Defined Task",
  description: [
    "If you have define a task using `defineTask` API end-point, then you",
    "can schedule the task to be scheduled using this method.",
    "This will announce the task as pending and workers will be allowed, to",
    "claim it and resolved the task.",
    "",
    "**Note** this operation is **idempotent** and will not fail or complain",
    "if called with `taskId` that is already scheduled, or even resolved.",
    "To reschedule a task previously resolved, use `rerunTask`."
  ].join('\n')
}, function(req, res) {
  // Validate parameters
  if (!checkParams(req, res)) {
    return;
  }

  var ctx = this;
  var taskId = req.params.taskId;

  // Load task status structure to find schedulerId and taskGroupId
  return ctx.Task.load(taskId).then(function(task) {
    // if no task is found, we return 404
    if (!task) {
      return res.status(404).json({
        message:  "Task not found already resolved"
      });
    }

    // Authenticate request by providing parameters
    if(!req.satisfies({
      schedulerId:    task.schedulerId,
      taskGroupId:    task.taskGroupId
    })) {
      return;
    }

    // If allowed, schedule the task in question
    return ctx.Task.schedule(taskId).then(function(task) {
      // Put message in appropriate azure queue
      return ctx.queueService.putTask(
        task.provisionerId,
        task.workerType,
        taskId,
         _.last(task.runs).runId,
        new Date(task.deadline)
      ).then(function() {
        // Make sure it's announced
        return ctx.publisher.taskPending({
          status:     task.status(),
          runId:      _.last(task.runs).runId
        }, task.routes).then(function() {
          // Wait for announcement to be completed, then reply to caller
          res.reply({
            status:     task.status()
          });
        });
      });
    });
  });
});


/** Get task status */
api.declare({
  method:   'get',
  route:    '/task/:taskId/status',
  name:     'status',
  scopes:   undefined,  // Still no auth required
  input:    undefined,  // No input is accepted
  output:   SCHEMA_PREFIX_CONST + 'task-status-response.json#',
  title:    "Get task status",
  description: [
    "Get task status structure from `taskId`"
  ].join('\n')
}, function(req, res) {
  // Validate parameters
  if (!checkParams(req, res)) {
    return;
  }

  var ctx     = this;
  var taskId  = req.params.taskId;

  // Try to load status from database
  return ctx.Task.load(taskId).then(function(task) {
    if (!task) {
      // Try to load status from blob storage
      return ctx.taskstore.get(
        taskId + '/status.json',
        true  // Return null if doesn't exists
      ).then(function(taskData) {
        if (taskData) {
          return ctx.Task.deserialize(taskData);
        }
      });
    }
    return task;
  }).then(function(task) {;
    if (!task) {
      res.status(409).json({
        message: "Task not found"
      });
    }
    // Reply with task status
    return res.reply({
      status: task.status()
    });
  });
});


/** Poll for a task */
api.declare({
  method:     'get',
  route:      '/poll-task-url/:provisionerId/:workerType',
  name:       'pollTaskUrls',
  scopes: [
    [
      'queue:poll-task-urls',
      'assume:worker-type:<provisionerId>/<workerType>'
    ]
  ],
  deferAuth:  true,
  output:     SCHEMA_PREFIX_CONST + 'poll-task-urls-response.json#',
  title:      "Get Urls to Poll Pending Tasks",
  description: [
    "Get a signed url to get a message from azure queue.",
    "Once messages are polled from here, you can claim the referenced task",
    "with `claimTask`."
  ].join('\n')
}, function(req, res) {
    // Validate parameters
  if (!checkParams(req, res)) {
    return;
  }

  var ctx = this;

  var provisionerId = req.params.provisionerId;
  var workerType    = req.params.workerType;

  // Authenticate request by providing parameters
  if(!req.satisfies({
    provisionerId:  provisionerId,
    workerType:     workerType
  })) {
    return;
  }

  // Construct signedUrl for accessing the azure queue for this
  // provisionerId and workerType
  return ctx.queueService.signedUrl(
    provisionerId,
    workerType
  ).then(function(result) {
    res.reply({
      signedPollTaskUrls: [
        result.getMessage
      ],
      expires:                  result.expiry.toJSON()
    });
  });
});

/** Claim a task */
api.declare({
  method:     'post',
  route:      '/task/:taskId/runs/:runId/claim',
  name:       'claimTask',
  scopes: [
    [
      'queue:claim-task',
      'assume:worker-type:<provisionerId>/<workerType>',
      'assume:worker-id:<workerGroup>/<workerId>'
    ]
  ],
  deferAuth:  true,
  input:      SCHEMA_PREFIX_CONST + 'task-claim-request.json#',
  output:     SCHEMA_PREFIX_CONST + 'task-claim-response.json#',
  title:      "Claim task",
  description: [
    "claim a task, more to be added later...",
    "",
    "**Warning,** in the future this API end-point will require the presents",
    "of `receipt`, `messageId` and `signature` in the body."
  ].join('\n')
}, function(req, res) {
  // Validate parameters
  if (!checkParams(req, res)) {
    return;
  }

  var ctx = this;

  var taskId = req.params.taskId;
  var runId  = parseInt(req.params.runId);

  var workerGroup = req.body.workerGroup;
  var workerId    = req.body.workerId;

  var messageId   = req.body.messageId;
  var receipt     = req.body.receipt;
  var signature   = req.body.signature;

  // Load task status structure to validate that we're allowed to claim it
  return ctx.Task.load(taskId).then(function(task) {
    // if task doesn't exist return 404
    if(!task) {
      return res.status(404).json({
        message: "Task not found, or already resolved!"
      });
    }

    // Authenticate request by providing parameters
    if(!req.satisfies({
      provisionerId:  task.provisionerId,
      workerType:     task.workerType,
      workerGroup:    workerGroup,
      workerId:       workerId
    })) {
      return;
    }

    // Validate signature, if present
    if (signature) {
      var valid = ctx.queueService.validateSignature(
        task.provisionerId, task.workerType,
        taskId, runId,
        task.deadline,
        signature
      );
      if (!valid) {
        return res.status(401).json({
          messsage: "Message was faked!"
        });
      }
    }

    // Set takenUntil to now + 20 min
    var takenUntil = new Date();
    var claimTimeout = parseInt(ctx.claimTimeout);
    takenUntil.setSeconds(takenUntil.getSeconds() + claimTimeout);

    // Claim run
    return ctx.Task.claimTaskRun(taskId, runId, {
      workerGroup:    workerGroup,
      workerId:       workerId,
      takenUntil:     takenUntil
    }).then(function(result) {
      // Return the "error" message if we have one
      if(!(result instanceof ctx.Task)) {
        res.status(result.code).json({
          message:      result.message
        });
        if (messageId && receipt && signature) {
          // Delete message from azure queue
          return ctx.queueService.deleteMessage(
            task.provisionerId,
            task.workerType,
            messageId,
            receipt
          );
        }
        return;
      }

      // Delete message from azure queue
      var messageDeleted = Promise.resolve();
      if (messageId && receipt && signature) {
        messageDeleted = ctx.queueService.deleteMessage(
          task.provisionerId,
          task.workerType,
          messageId,
          receipt
        );
      }

      return messageDeleted.then(function() {
        // Announce that the run is running
        return ctx.publisher.taskRunning({
          workerGroup:  workerGroup,
          workerId:     workerId,
          runId:        runId,
          takenUntil:   takenUntil.toJSON(),
          status:       result.status()
        }, result.routes);
      }).then(function() {
        // Reply to caller
        return res.reply({
          workerGroup:  workerGroup,
          workerId:     workerId,
          runId:        runId,
          takenUntil:   takenUntil.toJSON(),
          status:       result.status()
        });
      });
    });
  });
});


/** Reclaim a task */
api.declare({
  method:     'post',
  route:      '/task/:taskId/runs/:runId/reclaim',
  name:       'reclaimTask',
  scopes: [
    [
      'queue:claim-task',
      'assume:worker-id:<workerGroup>/<workerId>'
    ]
  ],
  deferAuth:  true,
  output:     SCHEMA_PREFIX_CONST + 'task-claim-response.json#',
  title:      "Reclaim task",
  description: [
    "reclaim a task more to be added later..."
  ].join('\n')
}, function(req, res) {
  // Validate parameters
  if (!checkParams(req, res)) {
    return;
  }

  var ctx = this;

  var taskId = req.params.taskId;
  var runId  = parseInt(req.params.runId);

  return ctx.Task.load(taskId).then(function(task) {
    var workerGroup = task.runs[runId].workerGroup;
    var workerId    = task.runs[runId].workerId;

    // Authenticate request by providing parameters
    if(!req.satisfies({
      workerGroup:    workerGroup,
      workerId:       workerId
    })) {
      return;
    }

    // Set takenUntil to now + claimTimeout
    var takenUntil = new Date();
    var claimTimeout = parseInt(ctx.claimTimeout);
    takenUntil.setSeconds(takenUntil.getSeconds() + claimTimeout);

    // Reclaim run
    return ctx.Task.reclaimTaskRun(taskId, runId, {
      workerGroup:    workerGroup,
      workerId:       workerId,
      takenUntil:     takenUntil
    }).then(function(result) {
      // Return the "error" message if we have one
      if(!(result instanceof ctx.Task)) {
        return res.status(result.code).json({
          message:      result.message
        });
      }

      // Reply to caller
      return res.reply({
        workerGroup:  workerGroup,
        workerId:     workerId,
        runId:        runId,
        takenUntil:   takenUntil.toJSON(),
        status:       result.status()
      });
    });
  });
});

/** Fetch work for a worker */
api.declare({
  method:     'post',
  route:      '/claim-work/:provisionerId/:workerType',
  name:       'claimWork',
  scopes: [
    [
      'queue:claim-task',
      'assume:worker-type:<provisionerId>/<workerType>',
      'assume:worker-id:<workerGroup>/<workerId>'
    ]
  ],
  deferAuth:  true,
  input:      SCHEMA_PREFIX_CONST + 'claim-work-request.json#',
  output:     SCHEMA_PREFIX_CONST + 'task-claim-response.json#',
  title:      "Claim work for a worker",
  description: [
    "Claim work for a worker, returns information about an appropriate task",
    "claimed for the worker. Similar to `claimTask`, which can be",
    "used to claim a specific task, or reclaim a specific task extending the",
    "`takenUntil` timeout for the run.",
    "",
    "**Note**, that if no tasks are _pending_ this method will not assign a",
    "task to you. Instead it will return `204` and you should wait a while",
    "before polling the queue again.",
    "",
    "**WARNING, this API end-point is deprecated and will be removed**."
  ].join('\n')
}, function(req, res) {
  // Validate parameters
  if (!checkParams(req, res)) {
    return;
  }

  var ctx = this;

  var provisionerId   = req.params.provisionerId;
  var workerType      = req.params.workerType;

  var workerGroup     = req.body.workerGroup;
  var workerId        = req.body.workerId;

  // Authenticate request by providing parameters
  if(!req.satisfies({
    provisionerId:  provisionerId,
    workerType:     workerType,
    workerGroup:    workerGroup,
    workerId:       workerId
  })) {
    return;
  }

  // Set takenUntil to now + 20 min
  var takenUntil = new Date();
  takenUntil.setSeconds(takenUntil.getSeconds() + 20 * 60);

  // Claim an arbitrary task
  return ctx.Task.claimWork({
    provisionerId:  provisionerId,
    workerType:     workerType,
    workerGroup:    workerGroup,
    workerId:       workerId
  }).then(function(result) {
    // Return the "error" message if we have one
    if(!(result instanceof ctx.Task)) {
      return res.status(409).json(result.code, {
        message:      result.message
      });
    }

    // Get runId from run that was claimed
    var runId = _.last(result.runs).runId;

    // Announce that the run is running
    return ctx.publisher.taskRunning({
      workerGroup:  workerGroup,
      workerId:     workerId,
      runId:        runId,
      takenUntil:   takenUntil.toJSON(),
      status:       result.status()
    }, result.routes).then(function() {
      // Reply to caller
      return res.reply({
        workerGroup:  workerGroup,
        workerId:     workerId,
        runId:        runId,
        takenUntil:   takenUntil.toJSON(),
        status:       result.status()
      });
    });
  });
});

/** Report task completed */
api.declare({
  method:     'post',
  route:      '/task/:taskId/runs/:runId/completed',
  name:       'reportCompleted',
  scopes: [
    [ //TODO: Remove the report-task-completed, and require queue:resolve-task
      'queue:report-task-completed',
      'assume:worker-id:<workerGroup>/<workerId>'
    ], [
      'queue:resolve-task',
      'assume:worker-id:<workerGroup>/<workerId>'
    ]
  ],
  deferAuth:  true,
  input:      SCHEMA_PREFIX_CONST + 'task-completed-request.json#',
  output:     SCHEMA_PREFIX_CONST + 'task-status-response.json#',
  title:      "Report Run Completed",
  description: [
    "Report a task completed, resolving the run as `completed`.",
    "",
    "For legacy, reasons the `success` parameter is accepted. This will be",
    "removed in the future."
  ].join('\n')
}, function(req, res) {
  // Validate parameters
  if (!checkParams(req, res)) {
    return;
  }

  var ctx = this;

  var taskId        = req.params.taskId;
  var runId         = parseInt(req.params.runId);
  var targetState   = req.body.success ? 'completed' : 'failed';

  return ctx.Task.load(taskId).then(function(task) {
    // if no task is found, we return 404
    if (!task || !task.runs[runId]) {
      return res.status(404).json({
        message:  "Task not found or already resolved"
      });
    }

    var workerGroup = task.runs[runId].workerGroup;
    var workerId    = task.runs[runId].workerId;

    // Authenticate request by providing parameters
    if(!req.satisfies({
      workerGroup:  workerGroup,
      workerId:     workerId
    })) {
      return;
    }

    // Resolve task run
    return ctx.Task.resolveTask(
      taskId,
      runId,
      targetState,
      targetState
    ).then(function(result) {
      // Return the "error" message if we have one
      if(!(result instanceof ctx.Task)) {
        return res.status(result.code).json({
          message:      result.message
        });
      }


      // Publish message
      var published = null;
      if (targetState === 'completed') {
        published = ctx.publisher.taskCompleted({
          status:       result.status(),
          runId:        runId,
          workerGroup:  workerGroup,
          workerId:     workerId
        }, task.routes);
      } else {
        published = ctx.publisher.taskFailed({
          status:       result.status(),
          runId:        runId,
          workerGroup:  workerGroup,
          workerId:     workerId
        }, task.routes);
      }

      return published.then(function() {
        return res.reply({
          status:   result.status()
        });
      });
    });
  });
});


/** Report task failed */
api.declare({
  method:     'post',
  route:      '/task/:taskId/runs/:runId/failed',
  name:       'reportFailed',
  scopes: [
    [
      'queue:resolve-task',
      'assume:worker-id:<workerGroup>/<workerId>'
    ]
  ],
  deferAuth:  true,
  input:      undefined,  // No input at this point
  output:     SCHEMA_PREFIX_CONST + 'task-status-response.json#',
  title:      "Report Run Failed",
  description: [
    "Report a run failed, resolving the run as `failed`. Use this to resolve",
    "a run that failed because the task specific code behaved unexpectedly.",
    "For example the task exited non-zero, or didn't produce expected output.",
    "",
    "Don't use this if the task couldn't be run because if malformed payload,",
    "or other unexpected condition. In these cases we have a task exception,",
    "which should be reported with `reportException`."
  ].join('\n')
}, function(req, res) {
  // Validate parameters
  if (!checkParams(req, res)) {
    return;
  }

  var ctx = this;

  var taskId        = req.params.taskId;
  var runId         = parseInt(req.params.runId);

  return ctx.Task.load(taskId).then(function(task) {
    // if no task is found, we return 404
    if (!task || !task.runs[runId]) {
      return res.status(404).json({
        message:  "Task not found or already resolved"
      });
    }

    var workerGroup = task.runs[runId].workerGroup;
    var workerId    = task.runs[runId].workerId;

    // Authenticate request by providing parameters
    if(!req.satisfies({
      workerGroup:  workerGroup,
      workerId:     workerId
    })) {
      return;
    }

    // Resolve task run
    return ctx.Task.resolveTask(
      taskId,
      runId,
      'failed',
      'failed'
    ).then(function(result) {
      // Return the "error" message if we have one
      if(!(result instanceof ctx.Task)) {
        return res.status(result.code).json({
          message:      result.message
        });
      }


      // Publish message
      return ctx.publisher.taskFailed({
        status:       result.status(),
        runId:        runId,
        workerGroup:  workerGroup,
        workerId:     workerId
      }, task.routes).then(function() {
        return res.reply({
          status:   result.status()
        });
      });
    });
  });
});

/** Report task exception */
api.declare({
  method:     'post',
  route:      '/task/:taskId/runs/:runId/exception',
  name:       'reportException',
  scopes: [
    [
      'queue:resolve-task',
      'assume:worker-id:<workerGroup>/<workerId>'
    ]
  ],
  deferAuth:  true,
  input:      SCHEMA_PREFIX_CONST + 'task-exception-request.json#',
  output:     SCHEMA_PREFIX_CONST + 'task-status-response.json#',
  title:      "Report Task Exception",
  description: [
    "Resolve a run as _exception_. Generally, you will want to report tasks as",
    "failed instead of exception. But if the payload is malformed, or",
    "dependencies referenced does not exists you should also report exception.",
    "However, do not report exception if an external resources is unavailable",
    "because of network failure, etc. Only if you can validate that the",
    "resource does not exist."
  ].join('\n')
}, function(req, res) {
  // Validate parameters
  if (!checkParams(req, res)) {
    return;
  }

  var ctx = this;

  var taskId        = req.params.taskId;
  var runId         = parseInt(req.params.runId);
  var reason        = req.body.reason;

  return ctx.Task.load(taskId).then(function(task) {
    // if no task is found, we return 404
    if (!task || !task.runs[runId]) {
      return res.status(404).json({
        message:  "Task not found or already resolved"
      });
    }

    var workerGroup = task.runs[runId].workerGroup;
    var workerId    = task.runs[runId].workerId;

    // Authenticate request by providing parameters
    if(!req.satisfies({
      workerGroup:  workerGroup,
      workerId:     workerId
    })) {
      return;
    }

    // Resolve task run
    return ctx.Task.resolveTask(
      taskId,
      runId,
      'exception',
      reason
    ).then(function(result) {
      // Return the "error" message if we have one
      if(!(result instanceof ctx.Task)) {
        return res.status(result.code).json({
          message:      result.message
        });
      }


      // Publish message
      return ctx.publisher.taskException({
        status:       result.status(),
        runId:        runId,
        workerGroup:  workerGroup,
        workerId:     workerId
      }, task.routes).then(function() {
        return res.reply({
          status:   result.status()
        });
      });
    });
  });
});


/** Rerun a previously resolved task */
api.declare({
  method:     'post',
  route:      '/task/:taskId/rerun',
  name:       'rerunTask',
  scopes:     [
    [
      'queue:rerun-task',
      'assume:scheduler-id:<schedulerId>/<taskGroupId>'
    ]
  ],
  deferAuth:  true,
  input:      undefined, // No input accepted
  output:     SCHEMA_PREFIX_CONST + 'task-status-response.json#',
  title:      "Rerun a Resolved Task",
  description: [
    "This method _reruns_ a previously resolved task, even if it was",
    "_completed_. This is useful if your task completes unsuccessfully, and",
    "you just want to run it from scratch again. This will also reset the",
    "number of `retries` allowed.",
    "",
    "Remember that `retries` in the task status counts the number of runs that",
    "the queue have started because the worker stopped responding, for example",
    "because a spot node died.",
    "",
    "**Remark** this operation is idempotent, if you try to rerun a task that",
    "isn't either `failed` or `completed`, this operation will just return the",
    "current task status."
  ].join('\n')
}, function(req, res) {
  // Validate parameters
  if (!checkParams(req, res)) {
    return;
  }

  var ctx     = this;
  var taskId  = req.params.taskId;

  // Fetch task from blob storage and validate scopes and find retries
  return ctx.taskstore.get(taskId + '/task.json', true).then(function(data) {
    // Check that we got a task definition
    if (!data) {
      return res.status(409).json({
        message:  "Task definition doesn't exist"
      });
    }

    // Check version of task information loaded
    assert(data.version === 1, "Expect task definition format version 1, "+
                               "don't know how to read newer versions");

    // Authenticate request by providing parameters
    if(!req.satisfies({
      schedulerId:    data.definition.schedulerId,
      taskGroupId:    data.definition.taskGroupId
    })) {
      return;
    }

    // Rerun the task
    return ctx.Task.rerunTask(taskId, {
      retries:  data.definition.retries,
      fetch:    function() {
                  return ctx.taskstore.get(taskId  + '/status.json', true);
                }
    }).then(function(result) {
      // Handle error cases
      if (!(result instanceof ctx.Task)) {
        return res.status(409).json(result.code, {
          message: result.message
        });
      }

      // Put message in appropriate azure queue
      return ctx.queueService.putTask(
        result.provisionerId,
        result.workerType,
        taskId,
         _.last(result.runs).runId,
        new Date(result.deadline)
      ).then(function() {
        // Publish message
        return ctx.publisher.taskPending({
          status:     result.status(),
          runId:      _.last(result.runs).runId
        }, result.routes).then(function() {
          // Reply to caller
          return res.reply({
            status:     result.status()
          });
        });
      });
    });
  });
});


// Load artifacts.js so API end-points declared in that file is loaded
require('./artifacts');


/** Fetch pending tasks */
api.declare({
  method:   'get',
  route:    '/pending-tasks/:provisionerId',
  name:     'getPendingTasks',
  scopes:   undefined,  // Still no auth required
  input:    undefined,  // TODO: define schema later
  output:   undefined,  // TODO: define schema later
  title:    "Fetch pending tasks for provisioner",
  description: [
    "Documented later...",
    "",
    "**Warning** this api end-point is **not stable**.",
    "",
    "**This end-point is deprecated!**"
  ].join('\n')
}, function(req, res) {
  // Validate parameters
  if (!checkParams(req, res)) {
    return;
  }

  var ctx           = this;
  var provisionerId = req.params.provisionerId;

  // When loaded reply
  ctx.Task.queryPending(provisionerId).then(function(tasks) {
    return Promise.all(tasks.map(function(taskId) {
      return ctx.Task.load(taskId);
    }));
  }).then(function(tasks) {
    return res.reply({
      tasks: tasks
    });
  });
});

/** Count pending tasks */
api.declare({
  method:     'get',
  route:      '/pending/:provisionerId',
  name:       'pendingTaskCount',
  scopes:     ['queue:pending-tasks:<provisionerId>'],
  deferAuth:  true,
  output:     undefined,  // TODO: define schema later
  title:      "Get Number of Pending Tasks",
  description: [
    "Documented later...",
    "",
    "**Warning: This is an experimental end-point!**"
  ].join('\n')
}, function(req, res) {
  // Validate parameters
  if (!checkParams(req, res)) {
    return;
  }

  var ctx           = this;
  var provisionerId = req.params.provisionerId;

  // Authenticate request by providing parameters
  if(!req.satisfies({
    provisionerId:  provisionerId
  })) {
    return;
  }

  return ctx.Task.pendingTasks(provisionerId).then(function(result) {
    return res.reply(result);
  });
});

/** Count pending tasks for workerType */
api.declare({
  method:     'get',
  route:      '/pending/:provisionerId/:workerType',
  name:       'pendingTasks',
  scopes:     ['queue:pending-tasks:<provisionerId>/<workerType>'],
  deferAuth:  true,
  output:     undefined,  // TODO: define schema later
  title:      "Get Number of Pending Tasks",
  description: [
    "Documented later...",
    "This probably the end-point that will remain after rewriting to azure",
    "queue storage...",
    "",
    "**Warning: This is an experimental end-point!**"
  ].join('\n')
}, function(req, res) {
  // Validate parameters
  if (!checkParams(req, res)) {
    return;
  }

  var ctx           = this;
  var provisionerId = req.params.provisionerId;
  var workerType    = req.params.workerType;

  // Authenticate request by providing parameters
  if(!req.satisfies({
    provisionerId:  provisionerId,
    workerType:     workerType
  })) {
    return;
  }

  // This implementation is stupid... but it works, just disregard
  // implementation details...
  return ctx.Task.pendingTasks(provisionerId).then(function(result) {
    return res.reply(result[workerType] || 0);
  });
});


/** Check that the server is a alive */
api.declare({
  method:   'get',
  route:    '/ping',
  name:     'ping',
  title:    "Ping Server",
  description: [
    "Documented later...",
    "",
    "**Warning** this api end-point is **not stable**."
  ].join('\n')
}, function(req, res) {
  res.status(200).json({
    alive:    true,
    uptime:   process.uptime()
  });
});