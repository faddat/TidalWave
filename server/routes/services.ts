/// <reference path='../../typings/node/node.d.ts' />

var fs = require('fs');
var express = require('express');
var toc = require('marked-toc');
var _ = require('lodash');
var Chance = require('chance');
var querystring = require('querystring');

var chance = new Chance();

import Hierarchy = require('../hierarchy');
import AuthHelper = require('../auth-helper');
import LiveSync = require('../livesync');
import options = require('../options-handler');

import SearchHandler = require('../search-handler');
import log = require('../logger');

import model = require('../model');
var Page = model.Page;
var PageVersion = model.PageVersion;
var User = model.User;
var Group = model.Group;
var Image = model.Image;
var FileData = model.FileData;
var AngularError = model.AngularError;

var queryPermissionWrapper = AuthHelper.queryPermissionWrapper;
var userCanAccessPage = AuthHelper.userCanAccessPage;
var updateDerivedPermissions = AuthHelper.updateDerivedPermissions;

var router = express.Router();

var RegExpEscape = function(s) {
    return s.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
};

var userPermissionFilter = function(user): Object {
  if (user) {
    return {
      or: [
        {
          terms: {
            userPermissions: [user._id]
          }
        },
        {
          terms: {
            groupPermissions: user.groups
          }
        },
        {
          terms: {
            derivedUserPermissions: [user._id]
          }
        },
        {
          terms: {
            derivedGroupPermissions: user.groups
          }
        },
        {
          term: {
            isPublic: true
          }
        }
      ]
    };
  } else {
    return {
      term: {
        isPublic: true
      }
    };
  }
};

router.post(
  '/me',
  function(req, res) {
    if (req.isAuthenticated()) {
      res.status(200).type('application/json').send(req.user);
    } else {
      res.status(200).type('application/json').send(null);
    }
  }
);

router.post(
  '/updateMe',
  function(req, res) {
    if (!req.isAuthenticated()) {
      log.warn("Tried to update user but not authenticated");
      res.status(403).end();
      return;
    }

    var newUser = req.body;
    if (newUser._id != req.user._id.toString()) {
      log.warn({message:"Tried to update user but wrong user id",requestedUser:newUser,actualId:req.user._id});
      res.status(403).end();
      return;
    }
    User.findByIdAndUpdate(
      newUser._id,
      newUser,
      function(err, dummyUser) {
        if (err) {
          log.error({error:err});
          res.status(500).end();
          return;
        }
        res.status(200).end();
      });
  }
);

router.post(
  '/updatePage',
  function(req, res) {
    if (!req.isAuthenticated()) {
      res.status(403).end();
      return;
    }

    var page = new Page(req.body);
    log.debug({text:"UPDATING PAGE:", page:page});

    Page.findById(
      page._id,
      function(err, outerPage) {
        userCanAccessPage(req.user,outerPage,function(outerSuccess) {
          if (!outerSuccess) {
            log.info("TRIED TO UPDATE PAGE WITHOUT ACCESS: " + req.user.email + " " + page.name);
            // Tried to update a page without access
            res.status(403).end();
            return;
          }
          userCanAccessPage(req.user,page,function(success) {
            if (success) {
              Page.findByIdAndUpdate(
                page._id,
                {$set:
                 {name:page.name,
                  parentId:page.parentId,
                  userPermissions:page.userPermissions,
                  groupPermissions:page.groupPermissions,
                  isPublic:page.isPublic
                 }},function(err, page) {
                   if (err) {
                     log.error({error:err});
                     res.status(500).end();
                     return;
                   }
                   log.debug("Updated successfully");
                   model.updateFullyQualifiedName(page, function() {
                     updateDerivedPermissions(page,function() {
                       Page.findById(page._id, function(err, innerPage) {
                         fetchPageDetailsForPage(
                           innerPage,
                           function(pageDetails) {
                             res.status(200).type("application/json").send(JSON.stringify(pageDetails));
                           },
                           function(error) {
                             log.error(error);
                             res.status(500).end();
                           });
                       });
                     });
                   });
                 });
            } else {
              log.info("UPDATE WOULD BAN USER FROM HIS OWN PAGE");
              // Tried to change permissions in a way that would ban the user doing the update.
              res.status(400).end();
            }
          });
        });
      });
  }
);

router.post(
  '/deletePage/:pageId',
  function(req, res) {
    if (!req.isAuthenticated()) {
      res.status(403).end();
      return;
    }

    var pageId = req.param('pageId');
    log.debug({text:"DELETING PAGE", pageId:pageId});

    Page.findById(
      pageId,
      function(err, page) {
        userCanAccessPage(req.user,page,function(outerSuccess) {
          if (!outerSuccess) {
            log.info("TRIED TO DELETE PAGE WITHOUT ACCESS: " + req.user.email + " " + page.name);
            // Tried to update a page without access
            res.status(403).end();
            return;
          }
          page.remove(function(err) {
            if (err) {
              log.error({message:"Error deleting page",error:err});
              res.status(500).end();
              return;
            }
            res.status(200).end();
          });
        });
      });
  }
);

router.post(
  '/getTOC/:pageId',
  function(req, res) {
    var pageId = req.param('pageId');

    queryPermissionWrapper(Page.findById(pageId), req.user)
      .exec(function(err, page) {
        if (err) {
          log.error({error:err});
          res.status(500).end();
        } else if (!page) {
          log.info("Tried to get table of contents for non-existant page: " + page);
          res.status(404).end();
        } else {
          userCanAccessPage(req.user,page,function(success) {
            if (success) {
              var contentWithHeader = "\n\n" + page.content;
              log.trace({message:"TOC generated",md:page.content,toc:toc(contentWithHeader)});
              res.status(200).type("text/x-markdown").send(toc(contentWithHeader));
            } else {
              res.status(403).end();
            }
          });
        }
      });
  }
);

router.post(
  '/pageStartsWith/:query',
  function(req, res) {
    var query = req.param('query');

    queryPermissionWrapper(
      Page.find({name:new RegExp("^"+RegExpEscape(query), "i")}), req.user)
      .limit(10)
      .exec(function(err, pages) {
        log.debug("Result for " + query + ": " + JSON.stringify(pages));
        res.status(200).type("application/json").send(JSON.stringify(pages));
      });
  }
);

var fetchPageDetailsForPage = function(page, success, failure) {
  var pageDetails = {
    page:page,
    version:null,
    userPermissions:[],
    groupPermissions:[],
    derivedUserPermissions:[],
    derivedGroupPermissions:[],
    editable:true,
    viewable:true
  };
  // Get all users on the permissions list
  User.find(
    {'_id': { $in: page.userPermissions }},
    function(err,users) {
      if (err) {
        failure(err);
        return;
      }
      for (var i=0;i<users.length;i++) {
        pageDetails.userPermissions.push(users[i]);
      }

      // Get all groups on the permissions list
      Group.find(
        {'_id': { $in: page.groupPermissions }},
        function(err, groups) {
          if (err) {
            failure(err);
            return;
          }
          for (var j=0;j<groups.length;j++) {
            pageDetails.groupPermissions.push(groups[j]);
          }

          // Get all derived user & group permissions
          User.find(
            {'_id': { $in: page.derivedUserPermissions }},
            function(err,users) {
              if (err) {
                failure(err);
                return;
              }
              for (var i=0;i<users.length;i++) {
                pageDetails.derivedUserPermissions.push(users[i]);
              }

              Group.find(
                {'_id': { $in: page.derivedGroupPermissions }},
                function(err, groups) {
                  if (err) {
                    failure(err);
                    return;
                  }
                  for (var j=0;j<groups.length;j++) {
                    pageDetails.derivedGroupPermissions.push(groups[j]);
                  }
                  success(pageDetails);
                });
            });
        });
    });
};

router.post(
  '/pageDetailsByFQN/*',
  function(req, res) {
    var fqn = querystring.unescape(req.path.substring('/pageDetailsByFQN/'.length));
    log.debug("Getting page details with name: " + fqn);
    queryPermissionWrapper(
      Page.findOne({fullyQualifiedName:fqn}), req.user)
      .exec(function(err, page) {
        log.debug("Got page: " + JSON.stringify(page));
        if (page) {
          fetchPageDetailsForPage(
            page,
            function(pageDetails) {
              res.status(200).type("application/json").send(JSON.stringify(pageDetails));
            },
            function(error) {
              log.error(error);
              res.status(500).end();
            });
        } else {
          Page.findOne({fullyQualifiedName:fqn}, function(err, permissionPage) {
            if (err) {
              log.error(err);
            }

            if (permissionPage) {
              fetchPageDetailsForPage(
                permissionPage,
                function(permissionPageDetails) {
                  permissionPageDetails.page.content = null;
                  permissionPageDetails.editable = false;
                  permissionPageDetails.viewable = false;
                  res.status(200).type("application/json").send(JSON.stringify(permissionPageDetails));
                },
                function(error) {
                  log.error(error);
                  res.status(500).end();
                });
            } else {
              log.error("User tried to access page with permission");
              res.status(404).end();
            }
          });
        }
      });
  }
);

router.post(
  '/pageHistory/:pageId',
  function(req, res) {
    log.debug("Getting history");
    var pageId = req.param('pageId');

    queryPermissionWrapper(
      Page.findById(pageId), req.user).exec(function(err, page) {
        if (err) {
          res.status(500).end();
          return;
        }
        if (!page) {
          res.status(403).end();
          return;
        }
        PageVersion.find({pageId:page._id}, function(err, pageVersions) {
          if (err) {
            res.status(500).end();
            return;
          }
          pageVersions.reverse();
          res.status(200).type("application/json").send(JSON.stringify(pageVersions));
        });
      });
  }
);


router.post(
  '/setPageParent/:pageId/:parentId',
  function(req, res) {
    var newParent = req.param('parentId');
    if (newParent == '___null___') {
      newParent = null;
    }
    queryPermissionWrapper(
      Page.findOne({_id:req.param('pageId')}), req.user)
      .exec(function(err, page) {
        if (page) {
          page.parentId = newParent;
          page.save(function(err, innerPage) {
            res.status(200).end();
          });
        } else {
          res.status(403).end();
        }
      });
  });

router.post(
  '/createPage',
  AuthHelper.ensureAuthenticated,
  function(req, res) {
    var newPageInfo = req.body;
    console.log("NEW PAGE INFO: ");
    console.log(newPageInfo);
    var pageName = newPageInfo.name;
    var parentId = newPageInfo.parentId;
    queryPermissionWrapper(
      Page.findOne({name:pageName}), req.user)
      .exec(function(err, page){
        if (page == null) {
          // Page does not exist yet, create

          var createPage = function(innerPage) {
            innerPage.save(function(err, innerInnerPage) {
              if (err) {
                log.error(err);
                res.status(500).end();
              } else {
                updateDerivedPermissions(innerPage,function() {
                  res.status(200).type("application/json").send(JSON.stringify(innerPage.fullyQualifiedName));
                });
              }
            });
          };

          var innerPage = new Page({name:pageName,parentId:parentId,content:'',userPermissions:[req.user._id]});
          if (parentId) {
            Page.findById(parentId, function(err, parentPage) {
              if (err) {
                log.error(err);
                res.status(500).end();
                return;
              }
              innerPage.fullyQualifiedName = parentPage.fullyQualifiedName + "/" + pageName;
              createPage(innerPage);
            });
          } else {
            innerPage.fullyQualifiedName = pageName;
            createPage(innerPage);
          }
        } else {
          res.status(400).end();
        }
      });
  }
);

router.post(
  '/savePageDynamicContent/:pageName',
  AuthHelper.ensureAuthenticated,
  function(req, res) {
    log.debug("SAVING DYNAMIC CONTENT");
    var pageName = req.param('pageName');
    LiveSync.sync(pageName, function() {
      log.debug("PAGE SAVED.  RETURNING 200");
      res.status(200).end();
    });
  }
);

router.post(
  '/findUserFullName/:fullName',
  function(req, res) {
    var fullName = req.param('fullName');
    User
      .find({fullName:new RegExp("^"+RegExpEscape(fullName), "i")})
      //.where('lastLoginTime').ne(null)
      .limit(5)
      .sort('fullName')
      .exec(function(err, users) {
        if (err) {
          log.error(err);
          res.status(500).end();
          return;
        }

        log.debug({results:users});
        res.status(200).type("application/json").send(JSON.stringify(users));
      });
  }
);

router.post(
  '/getUserByEmail/:email',
  function(req, res) {
    User
      .findOne({email:req.param('email')})
      .exec(function(err, user) {
        if (err) {
          log.error(err);
          res.status(500).end();
          return;
        }

        if (user) {
          res.status(200).type("application/json").send(JSON.stringify(user));
        } else {
          res.status(200).type("application/json").send(JSON.stringify(null));
        }
      });
  }
);

router.post(
  '/findGroupName/:name',
  function(req, res) {
    var name = req.param('name');
    Group
      .find({name:new RegExp("^"+RegExpEscape(name), "i")})
      .limit(5)
      .sort('name')
      .exec(function(err, groups) {
        if (err) {
          log.error(err);
          res.status(500).end();
          return;
        }

        log.debug({results:groups});
        res.status(200).type("application/json").send(JSON.stringify(groups));
      });
  }
);

router.post(
  '/findPageContent/:content',
  function(req, res) {
    var content = req.param('content');
    var client = SearchHandler.client;
    if (client) {
      log.info("Searching with elasticsearch");
      client.search({
        index: 'tidalwave.pages',
        body: {
          from:0,
          size:10,
          query: {
            filtered: {
              filter: userPermissionFilter(req.user),
              query: {
                match_phrase_prefix: {
                  content: {
                    query:'"'+content+'"',
                    prefix_length:3,
                    max_expansions : 100000
                  }
                }
              }
            }
          },
          sort: [
            { name: 'desc' }
          ]
        }
      }).then(function (body) {
        var hits = body.hits.hits;
        console.log(hits);
        var results = [];
        for (var i=0;i<hits.length;i++) {
          var result = hits[i]._source;
          result._id = hits[i]._id;
          results.push(result);
        }
        res.status(200).type("application/json").send(JSON.stringify(results));
      }, function (error) {
        log.error(error);
        res.status(500).end();
      });
    } else {
      log.info("Searching with mongoose");
      queryPermissionWrapper(Page
        .find({content:new RegExp(RegExpEscape(content), "i")}), req.user)
        .limit(10)
        .sort('name')
        .exec(function(err, pages) {
          if (err) {
            log.error(err);
            res.status(500).end();
            return;
          }

          log.debug({results:pages});
          res.status(200).type("application/json").send(JSON.stringify(pages));
        });
    }
  }
);

router.post(
  '/recentChangesVisible',
  function(req,res) {
    console.log("RECENT CHANGES VISIBLE");
    res.status(200).type("application/json").send("\"asdf\"");
  });

router.post(
  '/saveImage',
  AuthHelper.ensureAuthenticated,
  function(req,res) {
    console.log("SAVING IMAGE");
    var imageData = req.body;

    var uniqueName =
          imageData.pageId + "_" +
          chance.string({length: 8, pool:"1234567890abcdef"}) + "_" +
          imageData.name;

    var image = new Image({
      base64:imageData.base64,
      data:new Buffer(imageData.base64, 'base64'),
      mime:imageData.mime,
      name:uniqueName,
      filename:imageData.name});

    if (options.database.saveMediaToDb) {
      image.save(function (err) {
        if (err) {
          res.status(500).end();
          return;
        }
        res.status(200).type("text/plain").send(uniqueName);
      });
    } else {
      fs.writeFile('usermedia/'+uniqueName, JSON.stringify(image), function(err) {
        if (err) {
          res.status(500).end();
          return;
        }
        res.status(200).type("text/plain").send(uniqueName);
      });
    }
  });

router.get(
  '/getImage/:name',
  function(req,res) {
    var name = req.param('name');
    console.log("Getting image with name " + name);

    var pageId = name.split('_')[0];
    if (options.database.saveMediaToDb) {
      queryPermissionWrapper(
        Page.findById(pageId), req.user)
        .exec(function(err, page) {
          if (err) {
            res.status(500).end();
            return;
          }
          if (!page) {
            res.status(403).end();
            return;
          }

          Image.find({name:name}, function(err,results) {
            if (results.length>1) {
              res.status(500).end();
              return;
            } else if(results.length==0) {
              res.status(404).end();
              return;
            }
            var image = results[0];
            res.setHeader('Content-disposition', 'attachment; filename='+image.filename);
            res.status(200).type(image.mime).send(image.data);
          });
        });
    } else {
      Page.findById(pageId, function(err, page) {
        if (err) {
          res.status(500).end();
          return;
        }
        if (!page) {
          res.status(404).end();
          return;
        }
        AuthHelper.userCanAccessPage(req.user, page, function(canAccess) {
          if (!canAccess) {
            res.status(403).end();
            return;
          }

          var path = 'usermedia/'+name;
          fs.exists(path, function(exists) {
            if (!exists) {
              res.status(404).end();
              return;
            }
            fs.readFile(path, function(err, data) {
              if (err) {
                res.status(500).end();
                return;
              }
              var image = JSON.parse(data);
              // Note that image.data didn't survive going to JSON and back.
              res.setHeader('Content-disposition', 'attachment; filename='+image.filename);
              res.status(200).type(image.mime).send(new Buffer(image.base64, 'base64'));
            });
          });
        });
      });
    }
  });

router.post(
  '/saveFile',
  AuthHelper.ensureAuthenticated,
  function(req,res) {
    console.log("SAVING FILE");
    var fileDataJson = req.body;

    var uniqueName =
          fileDataJson.pageId + "_" +
          chance.string({length: 8, pool:"1234567890abcdef"}) + "_" +
          fileDataJson.name;

    var fileData = new FileData({
      base64:fileDataJson.base64,
      data:new Buffer(fileDataJson.base64, 'base64'),
      mime:fileDataJson.mime,
      name:uniqueName,
      filename:fileDataJson.name});

    if (options.database.saveMediaToDb) {
      fileData.save(function (err) {
        if (err) {
          console.dir(err);
          log.error({error:err});
          res.status(500).end();
          return;
        }
        res.status(200).type("text/plain").send(uniqueName);
      });
    } else {
      fs.writeFile('usermedia/'+uniqueName, JSON.stringify(fileData), function(err) {
        if (err) {
          res.status(500).end();
          return;
        }
        res.status(200).type("text/plain").send(uniqueName);
      });
    }
  });

router.get(
  '/getFile/:name',
  function(req,res) {
    var name = req.param('name');
    console.log("Getting file with name " + name);

    var pageId = name.split('_')[0];
    if (options.database.saveMediaToDb) {
      queryPermissionWrapper(
        Page.findById(pageId), req.user)
        .exec(function(err, page) {
          if (err) {
            res.status(500).end();
            return;
          }
          if (!page) {
            res.status(403).end();
            return;
          }

          FileData.find({name:name}, function(err,results) {
            if (results.length>1) {
              res.status(500).end();
              return;
            } else if(results.length==0) {
              res.status(404).end();
              return;
            }
            var file = results[0];
            res.setHeader('Content-disposition', 'attachment; filename='+file.filename);
            res.status(200).type(file.mime).send(file.data);
          });
        });
    } else {
      Page.findById(pageId, function(err, page) {
        if (err) {
          res.status(500).end();
          return;
        }
        if (!page) {
          res.status(404).end();
          return;
        }
        AuthHelper.userCanAccessPage(req.user, page, function(canAccess) {
          if (!canAccess) {
            res.status(403).end();
            return;
          }

          var path = 'usermedia/'+name;
          fs.exists(path, function(exists) {
            if (!exists) {
              res.status(404).end();
              return;
            }
            fs.readFile(path, function(err, data) {
              if (err) {
                res.status(500).end();
                return;
              }
              var fileData = JSON.parse(data);
              // Note that fileData.data didn't survive going to JSON and back.
              res.setHeader('Content-disposition', 'attachment; filename='+fileData.filename);
              res.status(200).type(fileData.mime).send(new Buffer(fileData.base64, 'base64'));
            });
          });
        });
      });
    }

  });

router.post(
  '/angularerror',
  function(req, res) {
    var errorDetails = req.body;
    console.log("ERROR DETAILS");
    console.dir(errorDetails);
    new AngularError(errorDetails).save(function(err) {
      if (err) {
        log.error({error:err});
        res.status(500).end();
      } else {
        res.status(200).end();
      }
    });
  }
);

router.post(
  '/hierarchy',
  function(req, res) {
    Hierarchy.fetch(req.user,{},function(hierarchy) {
      res.type('application/json').status(200).send(JSON.stringify(hierarchy));
    });
  }
);

router.post(
  '/hierarchyStartsWith',
  function(req, res) {
    Hierarchy.fetch(req.user,{name: new RegExp("^"+RegExpEscape(req.param('query')), "i")}, function(result) {
      res
        .type('application/json')
        .status(200)
        .send(JSON.stringify(result));
    });
  }
);

module.exports = router;
