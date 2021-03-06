/// <reference path='../typings/node/node.d.ts' />
/// <reference path='../typings/mongodb/mongodb.d.ts' />
/// <reference path='../typings/express/express.d.ts' />

import log = require('./logger');

import model = require('./model');
var Page = model.Page;
var PageVersion = model.PageVersion;
var User = model.User;

import AuthHelper = require('./auth-helper');

export var getAncestry = function(page, callback) {
  if (page.parentId) {
    Page.findById(page.parentId,function(err, parentPage) {
      if (err || !parentPage) {
        callback(["Error"]);
        return;
      }
      getAncestry(parentPage, function(parentAncestry) {
        parentAncestry.push({_id:page._id,name:page.name,fqn:page.fullyQualifiedName});
        callback(parentAncestry);
      });
    });
  } else {
    callback([{_id:page._id,name:page.name,fqn:page.fullyQualifiedName}]);
  }
};

var getAncestryClosure = function(pages, callback) {
  log.info("Getting closure of " + pages.length + " pages");
  var pageIndexMap = {};

  for (var k=0;k<pages.length;k++) {
    pageIndexMap[pages[k]._id] = k;
  }

  var pagesToAdd = [];
  for (var a=0;a<pages.length;a++) {
    var onPage = pages[a];
    while (onPage) {
      var parentId = onPage.parentId;
      if (parentId) {
        if(parentId in pageIndexMap) {
          // Keep checking parents
          onPage = pages[pageIndexMap[parentId]];
        } else {
          // We need to add a parent
          pagesToAdd.push(parentId);
          break;
        }
      } else {
        break;
      }
    }
  }

  if (pagesToAdd.length==0) {
    // We are done.
    callback(pages);
  } else {
    // We need to add more pages and try again
    Page.find({'_id': { $in: pagesToAdd }}, function(err, parentPages){
      if (err) {
        log.error(err);
        return;
      }

      for (var a=0;a<parentPages.length;a++) {
        pages.push(parentPages[a]);
      }

      getAncestryClosure(pages,callback);
    });
  }
};

export var fetch = function(user,filter,cb) {
  log.debug("Finding with filter: " + JSON.stringify(filter));
  AuthHelper.queryPermissionWrapper(Page.find(filter),user)
    .exec(function(err, pagesWithoutParents) {
      if (err) {
        log.error({error:err});
        console.log(err.message);
      }

      getAncestryClosure(pagesWithoutParents, function(pages) {
        var completed = {};
        var pageIndexMap = {};
        var pageHierarchy = [];

        for (var k=0;k<pages.length;k++) {
          pageIndexMap[pages[k]._id] = k;
        }

        for (var j=0;j<pages.length;j++) {
          for (var i=0;i<pages.length;i++) {
            if (completed[i]) {
              continue;
            }
            var page = pages[i];
            if (!page.parentId) {
              completed[i] = {id:page._id,name:page.name,children:[],fqn:page.fullyQualifiedName};
              pageHierarchy.push(completed[i]);
            } else if (page.parentId in pageIndexMap && completed[pageIndexMap[page.parentId]]) {
              completed[i] = {id:page._id,name:page.name,children:[],fqn:page.fullyQualifiedName};
              completed[pageIndexMap[page.parentId]].children.push(completed[i]);
            }
          }
          if (Object.keys(completed).length == pages.length) {
            break;
          }
        }

        //console.log("FINAL HIERARCHY: " + JSON.stringify(pageHierarchy));
        cb(pageHierarchy);
      });

    });
};
